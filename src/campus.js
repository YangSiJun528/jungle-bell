(() => {
    'use strict';

    const KST_TIME_ZONE = 'Asia/Seoul';
    const REQUEST_TIMEOUT_MS = 10_000;
    const REFRESH_INTERVAL_MS = {
        laundry: 30_000,
        meals: 60_000,
    };
    const CACHE_KEYS = {
        laundry: 'jungle-bell:campus:laundry:v1',
        meals: 'jungle-bell:campus:meals:v1',
    };
    const VALID_TABS = new Set(['laundry', 'meals']);
    const ACTIVE_STATUSES = new Set(['RUNNING', 'PAUSED', 'SCHEDULED']);
    const ISSUE_PROJECTIONS = new Set(['AWAITING_COMPLETION_CONFIRMATION', 'ERROR', 'UNKNOWN']);

    const initialTab = new URLSearchParams(window.location.search).get('tab');
    const state = {
        activeTab: VALID_TABS.has(initialTab) ? initialTab : 'laundry',
        laundryFilter: 'all',
        apiBase: null,
        apiBasePromise: null,
        refreshTimer: null,
        domReady: false,
        data: {laundry: null, meals: null},
        savedAt: {laundry: null, meals: null},
        sourceMode: {laundry: 'none', meals: 'none'},
        cacheRead: {laundry: false, meals: false},
        inFlight: {laundry: null, meals: null},
    };

    function element(tagName, className, text) {
        const node = document.createElement(tagName);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    function parseDate(value) {
        if (!value) return null;
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    function relativeTime(value) {
        const parsed = value instanceof Date ? value : parseDate(value);
        if (!parsed) return '확인 시각 없음';
        const seconds = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 1000));
        if (seconds < 30) return '방금';
        if (seconds < 60) return `${seconds}초 전`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}분 전`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}시간 전`;
        return `${Math.floor(hours / 24)}일 전`;
    }

    function formatClock(value) {
        const parsed = parseDate(value);
        if (!parsed) return null;
        return new Intl.DateTimeFormat('ko-KR', {
            timeZone: KST_TIME_ZONE,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).format(parsed);
    }

    function kstDateParts(value = new Date()) {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: KST_TIME_ZONE,
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
        }).formatToParts(value);
        const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
        return {
            year: Number(values.year),
            month: Number(values.month),
            day: Number(values.day),
        };
    }

    function formatToday() {
        return new Intl.DateTimeFormat('ko-KR', {
            timeZone: KST_TIME_ZONE,
            month: 'long',
            day: 'numeric',
            weekday: 'long',
        }).format(new Date());
    }

    function readCache(tab) {
        try {
            const raw = localStorage.getItem(CACHE_KEYS[tab]);
            if (!raw) return null;
            const record = JSON.parse(raw);
            if (!record || typeof record.savedAt !== 'number' || !record.data) return null;
            return record;
        } catch (error) {
            console.warn(`[campus] ${tab} cache read failed`, error);
            return null;
        }
    }

    function writeCache(tab, data) {
        const savedAt = Date.now();
        try {
            localStorage.setItem(CACHE_KEYS[tab], JSON.stringify({savedAt, data}));
        } catch (error) {
            console.warn(`[campus] ${tab} cache write failed`, error);
        }
        return savedAt;
    }

    function normalizeApiBase(value) {
        const parsed = new URL(value);
        const localHttp = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
        if (parsed.protocol !== 'https:' && !localHttp) throw new Error('Invalid data API URL');
        parsed.pathname = parsed.pathname.replace(/\/+$/, '');
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString().replace(/\/$/, '');
    }

    async function resolveApiBase() {
        if (state.apiBase) return state.apiBase;
        if (state.apiBasePromise) return state.apiBasePromise;

        state.apiBasePromise = (async () => {
            const tauriInvoke = window.__TAURI__?.core?.invoke;
            if (tauriInvoke) {
                return normalizeApiBase(await tauriInvoke('get_data_api_base_url'));
            }

            const browserOverride = new URLSearchParams(window.location.search).get('api');
            if (browserOverride) return normalizeApiBase(browserOverride);
            return normalizeApiBase('http://127.0.0.1:8787');
        })();

        try {
            state.apiBase = await state.apiBasePromise;
            return state.apiBase;
        } finally {
            state.apiBasePromise = null;
        }
    }

    async function fetchJson(path, manual) {
        const apiBase = await resolveApiBase();
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(`${apiBase}${path}`, {
                method: 'GET',
                headers: {Accept: 'application/json'},
                cache: manual ? 'no-cache' : 'default',
                credentials: 'omit',
                signal: controller.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } finally {
            window.clearTimeout(timeout);
        }
    }

    function isLaundryPayload(data) {
        return data?.schemaVersion === 1 && Array.isArray(data.machines) && data.quality;
    }

    function isMealsPayload(data) {
        return data?.data?.schemaVersion === 1
            && Array.isArray(data.data.dailyMenus)
            && Array.isArray(data.data.pinnedMenus);
    }

    function setSourceState(tab, title, detail, tone) {
        const source = document.getElementById(`${tab}-source`);
        source.dataset.tone = tone;
        document.getElementById(`${tab}-source-title`).textContent = title;
        document.getElementById(`${tab}-source-detail`).textContent = detail;
    }

    function showContentState(tab, title, detail, retry = false, loading = false) {
        document.getElementById(`${tab}-view`).hidden = true;
        const container = document.getElementById(`${tab}-state`);
        container.hidden = false;
        container.replaceChildren();
        if (loading) container.append(element('span', 'loading-spinner'));
        const titleNode = element('strong', null, title);
        container.append(titleNode);
        if (detail) container.append(element('span', null, detail));
        if (retry) {
            const button = element('button', 'secondary-btn', '다시 시도');
            button.type = 'button';
            button.addEventListener('click', () => refreshTab(tab, true));
            container.append(button);
        }
    }

    function showDataView(tab) {
        document.getElementById(`${tab}-state`).hidden = true;
        document.getElementById(`${tab}-view`).hidden = false;
    }

    function setRefreshBusy(tab, busy) {
        if (state.activeTab !== tab) return;
        const button = document.getElementById('refresh-btn');
        button.disabled = busy;
        button.classList.toggle('is-refreshing', busy);
        button.setAttribute('aria-busy', String(busy));
    }

    function sourceCacheDetail(tab) {
        const savedAt = state.savedAt[tab];
        return savedAt ? `저장된 정보 · ${relativeTime(new Date(savedAt))}` : '저장된 정보';
    }

    function loadCachedTab(tab) {
        if (state.cacheRead[tab]) return;
        state.cacheRead[tab] = true;
        const cached = readCache(tab);
        if (!cached) return;
        const valid = tab === 'laundry' ? isLaundryPayload(cached.data) : isMealsPayload(cached.data);
        if (!valid) return;
        state.data[tab] = cached.data;
        state.savedAt[tab] = cached.savedAt;
        state.sourceMode[tab] = 'cache';
        renderTab(tab);
    }

    function scheduleRefresh() {
        window.clearTimeout(state.refreshTimer);
        if (document.hidden) return;
        state.refreshTimer = window.setTimeout(
            () => refreshTab(state.activeTab, false),
            REFRESH_INTERVAL_MS[state.activeTab],
        );
    }

    async function refreshTab(tab, manual) {
        if (state.inFlight[tab]) return state.inFlight[tab];
        setRefreshBusy(tab, true);
        const path = tab === 'laundry' ? '/v1/laundry/latest' : '/v1/meals';
        const validate = tab === 'laundry' ? isLaundryPayload : isMealsPayload;

        state.inFlight[tab] = (async () => {
            try {
                const data = await fetchJson(path, manual);
                if (!validate(data)) throw new Error('Unexpected API response');
                state.data[tab] = data;
                state.savedAt[tab] = writeCache(tab, data);
                state.sourceMode[tab] = 'live';
                renderTab(tab);
            } catch (error) {
                console.error(`[campus] ${tab} refresh failed`, error);
                if (state.data[tab]) {
                    state.sourceMode[tab] = 'cache';
                    renderTab(tab);
                } else {
                    const isConfigurationError = String(error).includes('API 주소');
                    setSourceState(
                        tab,
                        isConfigurationError ? '데이터 API 연결 필요' : '데이터를 가져오지 못함',
                        isConfigurationError ? '앱 빌드 설정을 확인해 주세요.' : '네트워크 연결 또는 수집 상태를 확인해 주세요.',
                        'danger',
                    );
                    showContentState(
                        tab,
                        isConfigurationError ? '데이터 API가 연결되지 않았습니다.' : '현재 정보를 불러올 수 없습니다.',
                        null,
                        !isConfigurationError,
                    );
                }
            } finally {
                state.inFlight[tab] = null;
                setRefreshBusy(tab, false);
                if (state.activeTab === tab) scheduleRefresh();
            }
        })();

        return state.inFlight[tab];
    }

    function renderTab(tab) {
        if (!state.data[tab]) return;
        if (tab === 'laundry') renderLaundry(state.data.laundry);
        else renderMeals(state.data.meals);
    }

    function applianceIsActive(appliance) {
        if (!appliance) return false;
        return ACTIVE_STATUSES.has(appliance.operationalStatus)
            || appliance.projection?.status === 'AWAITING_COMPLETION_CONFIRMATION';
    }

    function applianceIsAvailable(appliance) {
        return appliance?.operationalStatus === 'IDLE';
    }

    function applianceNeedsAttention(appliance) {
        return Boolean(appliance && (
            ISSUE_PROJECTIONS.has(appliance.projection?.status)
            || appliance.operationalStatus === 'PAUSED'
        ));
    }

    function projectionView(appliance) {
        if (!appliance) return {label: '정보 없음', tone: 'neutral'};
        const projection = appliance.projection?.status;
        const projectionLabel = appliance.projection?.statusLabelKo;
        if (projection === 'AWAITING_COMPLETION_CONFIRMATION') return {label: projectionLabel ?? '완료 확인 중', tone: 'warning'};
        if (projection === 'CONFIRMED_COMPLETED') return {label: projectionLabel ?? '완료', tone: 'complete'};
        if (projection === 'PAUSED') return {label: projectionLabel ?? '일시 정지', tone: 'warning'};
        if (projection === 'ERROR') return {label: projectionLabel ?? '오류', tone: 'danger'};
        if (projection === 'UNKNOWN') return {label: projectionLabel ?? '확인 불가', tone: 'neutral'};
        if (appliance.operationalStatus === 'SCHEDULED') {
            return {label: appliance.operationalStatusLabelKo ?? '예약됨', tone: 'normal'};
        }
        if (projection === 'IDLE') return {label: projectionLabel ?? '사용 가능', tone: 'success'};
        return {label: appliance.state?.labelKo ?? projectionLabel ?? appliance.operationalStatusLabelKo ?? '작동 중', tone: 'normal'};
    }

    function remainingText(appliance) {
        if (!appliance) return '--';
        const status = appliance.projection?.status;
        if (status === 'CONFIRMED_COMPLETED') return '완료';
        if (status === 'ERROR') return '오류';
        if (status === 'IDLE') return appliance.operationalStatus === 'SCHEDULED' ? '예약' : '대기';
        if (status === 'UNKNOWN') return '--';
        const minutes = appliance.projection?.remainingMinutes;
        if (!Number.isFinite(minutes)) return '--';
        if (minutes >= 60) {
            const hours = Math.floor(minutes / 60);
            const rest = minutes % 60;
            return rest ? `${hours}시간 ${rest}분` : `${hours}시간`;
        }
        return `${minutes}분`;
    }

    function machineName(id) {
        const text = String(id ?? '').trim();
        const number = text.match(/(?:워시타워[_\s-]*)?(\d+)$/)?.[1];
        return number ? `${number}번 워시타워` : text.replaceAll('_', ' ');
    }

    function machineRank(machine) {
        const appliances = [machine.washer, machine.dryer].filter(Boolean);
        if (appliances.some(applianceNeedsAttention)) return 0;
        if (appliances.some(applianceIsActive)) return 1;
        if (appliances.some(applianceIsAvailable)) return 2;
        return 3;
    }

    function adjustmentMessage(events, appliance) {
        if (!appliance) return null;
        const matching = events
            .filter((event) => event.machineId === appliance.machineId && event.appliance === appliance.appliance)
            .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));
        const priority = [
            'ERROR_ENTERED',
            'ETA_EXTENDED',
            'ETA_REDUCED',
            'TOTAL_TIME_ADJUSTED',
            'ERROR_CLEARED',
            'COMPLETED',
            'STARTED',
        ];
        const current = priority.map((type) => matching.find((event) => event.type === type)).find(Boolean);
        if (!current) return null;

        const delta = Math.abs(Math.round(current.etaDeltaMinutes ?? 0));
        if (current.type === 'ETA_EXTENDED') return `예상 종료가 ${delta}분 늦어졌습니다.`;
        if (current.type === 'ETA_REDUCED') return `예상 종료가 ${delta}분 빨라졌습니다.`;
        if (current.type === 'TOTAL_TIME_ADJUSTED') {
            const previous = current.detail?.previousTotalMinutes;
            const next = current.detail?.currentTotalMinutes;
            return Number.isFinite(previous) && Number.isFinite(next)
                ? `전체 시간이 ${previous}분에서 ${next}분으로 조정됐습니다.`
                : '전체 시간이 조정됐습니다.';
        }
        if (current.type === 'ERROR_ENTERED') return '기기 오류가 감지됐습니다.';
        if (current.type === 'ERROR_CLEARED') return '기기 오류가 해제됐습니다.';
        if (current.type === 'COMPLETED') return '작동 완료가 확인됐습니다.';
        if (current.type === 'STARTED') return '작동 시작이 확인됐습니다.';
        return null;
    }

    function infoDisclosure(message, label) {
        const wrapper = element('div', 'inline-info');
        const button = element('button', 'info-icon-btn');
        button.type = 'button';
        button.title = label;
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-expanded', 'false');
        button.append(element('span', null, 'i'));
        button.firstElementChild.setAttribute('aria-hidden', 'true');

        const detail = element('p', 'inline-info-detail', message);
        detail.hidden = true;
        button.addEventListener('click', () => {
            const expanded = button.getAttribute('aria-expanded') === 'true';
            button.setAttribute('aria-expanded', String(!expanded));
            detail.hidden = expanded;
        });
        wrapper.append(button, detail);
        return wrapper;
    }

    function renderAppliance(appliance, kind, events) {
        const item = element('section', 'appliance-row');
        const view = projectionView(appliance);
        item.dataset.tone = view.tone;

        const main = element('div', 'appliance-row-main');
        const heading = element('div', 'appliance-heading');
        heading.append(element('h4', null, kind === 'washer' ? '세탁기' : '건조기'));
        const badge = element('span', 'status-badge', view.label);
        badge.dataset.tone = view.tone;
        heading.append(badge);
        main.append(heading);

        if (!appliance) {
            main.append(element('p', 'appliance-unavailable', '기기 정보 없음'));
            item.append(main);
            return item;
        }

        const timeRow = element('div', 'appliance-time-row');
        timeRow.append(element('strong', 'remaining-time', remainingText(appliance)));
        const estimateLabel = appliance.projection?.estimated ? '추정' : '관측';
        timeRow.append(element('span', 'estimate-label', estimateLabel));
        main.append(timeRow);
        item.append(main);

        const projectionMinutes = appliance.projection?.remainingMinutes;
        if (appliance.totalMinutes > 0 && Number.isFinite(projectionMinutes) && applianceIsActive(appliance)) {
            const progress = Math.min(100, Math.max(0, ((appliance.totalMinutes - projectionMinutes) / appliance.totalMinutes) * 100));
            const track = element('div', 'progress-track');
            track.setAttribute('role', 'progressbar');
            track.setAttribute('aria-label', `${kind === 'washer' ? '세탁' : '건조'} 진행률`);
            track.setAttribute('aria-valuemin', '0');
            track.setAttribute('aria-valuemax', '100');
            track.setAttribute('aria-valuenow', String(Math.round(progress)));
            const fill = element('span', 'progress-fill');
            fill.style.width = `${progress}%`;
            track.append(fill);
            item.append(track);
        }

        const metadata = element('div', 'appliance-meta');
        const finishAt = appliance.estimatedFinishAt ? formatClock(appliance.estimatedFinishAt) : null;
        if (finishAt && applianceIsActive(appliance)) metadata.append(element('span', null, `예상 종료 ${finishAt}`));
        metadata.append(element('span', null, `원격 관측 ${relativeTime(appliance.observedAt)}`));
        if (appliance.errorCode) metadata.append(element('span', 'error-code', `오류 코드 ${appliance.errorCode}`));
        item.append(metadata);

        const adjustment = adjustmentMessage(events, appliance);
        if (adjustment) item.append(infoDisclosure(adjustment, `${kind === 'washer' ? '세탁기' : '건조기'} 상태 변경 안내`));
        return item;
    }

    function renderMachine(machine, events) {
        const card = element('article', 'laundry-card');
        const cardHeader = element('div', 'laundry-card-header');
        cardHeader.append(element('h3', null, machineName(machine.id)));
        const available = [machine.washer, machine.dryer].filter(applianceIsAvailable).length;
        const active = [machine.washer, machine.dryer].filter(applianceIsActive).length;
        const summary = active > 0 ? `${active}대 작동 중` : available > 0 ? `${available}대 사용 가능` : '상태 확인 필요';
        cardHeader.append(element('span', null, summary));
        card.append(cardHeader);

        const appliances = element('div', 'appliance-grid');
        appliances.append(renderAppliance(machine.washer, 'washer', events));
        appliances.append(renderAppliance(machine.dryer, 'dryer', events));
        card.append(appliances);
        return card;
    }

    function freshnessView(freshness, labelKo) {
        const values = {
            REFRESH_OBSERVED: ['원격 상태 갱신됨', 'success'],
            WITHIN_REFRESH_WINDOW: ['다음 원격 갱신 대기', 'normal'],
            REFRESH_OVERDUE: ['원격 갱신 지연', 'warning'],
            UNVERIFIABLE_STABLE: ['상태 변화 없음', 'neutral'],
            COLLECTION_GAP: ['수집 연결 지연', 'danger'],
        };
        const [fallbackTitle, tone] = values[freshness] ?? ['갱신 상태 확인 중', 'neutral'];
        return {title: labelKo ?? fallbackTitle, tone};
    }

    function updateLaundryTypeSummary(kind, appliances) {
        const total = appliances.length;
        const available = appliances.filter(applianceIsAvailable).length;
        const active = appliances.filter(applianceIsActive).length;
        const issue = appliances.filter(applianceNeedsAttention).length;
        const percent = total > 0 ? Math.round((available / total) * 100) : 0;
        document.getElementById(`${kind}-available`).textContent = String(available);
        document.getElementById(`${kind}-total`).textContent = String(total);
        document.getElementById(`${kind}-active`).textContent = String(active);
        document.getElementById(`${kind}-issue`).textContent = String(issue);
        const fill = document.getElementById(`${kind}-availability-fill`);
        fill.style.width = `${percent}%`;
        fill.parentElement.setAttribute('aria-valuenow', String(percent));
    }

    function setLaundryInfo(message) {
        const button = document.getElementById('laundry-info-btn');
        const note = document.getElementById('laundry-note');
        note.textContent = message ?? '';
        note.hidden = true;
        button.hidden = !message;
        button.setAttribute('aria-expanded', 'false');
    }

    function renderLaundry(data) {
        showDataView('laundry');
        const cached = state.sourceMode.laundry === 'cache';
        const freshness = freshnessView(data.quality?.sourceFreshness, data.quality?.sourceFreshnessLabelKo);
        setSourceState(
            'laundry',
            cached ? '저장된 세탁기 상태' : freshness.title,
            cached
                ? sourceCacheDetail('laundry')
                : `LG ThinQ 확인 ${relativeTime(data.quality?.lastCheckedAt)} · 약 5분 간격`,
            cached ? 'warning' : freshness.tone,
        );

        const appliances = data.machines.flatMap((machine) => [machine.washer, machine.dryer]).filter(Boolean);
        updateLaundryTypeSummary('washer', data.machines.map((machine) => machine.washer).filter(Boolean));
        updateLaundryTypeSummary('dryer', data.machines.map((machine) => machine.dryer).filter(Boolean));
        document.getElementById('laundry-updated-at').textContent = `LG ThinQ ${relativeTime(data.quality?.lastCheckedAt)}`;
        document.getElementById('laundry-tower-count').textContent = `${data.machines.length}대`;

        const awaitingConfirmation = appliances.some((appliance) => appliance.projection?.status === 'AWAITING_COMPLETION_CONFIRMATION');
        const hasEstimate = appliances.some((appliance) => appliance.projection?.estimated);
        if (cached) {
            setLaundryInfo('마지막으로 저장된 상태입니다. 잔여 시간은 현재 시각과 다를 수 있습니다.');
        } else if (awaitingConfirmation) {
            setLaundryInfo('0분이어도 LG ThinQ에서 완료 상태가 확인될 때까지 완료 확인 중으로 표시합니다.');
        } else if (hasEstimate) {
            setLaundryInfo('잔여 시간과 종료 시각은 마지막 LG ThinQ 관측값을 기준으로 계산한 추정치입니다.');
        } else {
            setLaundryInfo(null);
        }

        const filtered = data.machines
            .filter((machine) => {
                const machineAppliances = [machine.washer, machine.dryer].filter(Boolean);
                if (state.laundryFilter === 'active') return machineAppliances.some(applianceIsActive);
                if (state.laundryFilter === 'available') return machineAppliances.some(applianceIsAvailable);
                return true;
            })
            .sort((left, right) => {
                const rankDelta = machineRank(left) - machineRank(right);
                return rankDelta || String(left.id).localeCompare(String(right.id), 'ko', {numeric: true});
            });

        const list = document.getElementById('laundry-list');
        list.replaceChildren();
        if (filtered.length === 0) {
            list.append(element('div', 'inline-empty', state.laundryFilter === 'active'
                ? '현재 작동 중인 기기가 없습니다.'
                : '현재 사용 가능한 기기가 없습니다.'));
            return;
        }
        for (const machine of filtered) list.append(renderMachine(machine, data.events ?? []));
    }

    function mealPeriod(post) {
        if (post?.title?.includes('중식')) return 'lunch';
        if (post?.title?.includes('석식')) return 'dinner';
        return null;
    }

    function postIsToday(post) {
        const today = kstDateParts();
        const titleDate = post?.title?.match(/(\d{1,2})월\s*(\d{1,2})일/);
        if (titleDate) return Number(titleDate[1]) === today.month && Number(titleDate[2]) === today.day;
        const published = parseDate(post?.publishedAt);
        if (!published) return false;
        const publishedParts = kstDateParts(published);
        return publishedParts.year === today.year
            && publishedParts.month === today.month
            && publishedParts.day === today.day;
    }

    function safeAssetUrl(value) {
        if (!value) return null;
        try {
            const parsed = new URL(value);
            const localHttp = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
            if ((parsed.protocol !== 'https:' && !localHttp) || !parsed.pathname.startsWith('/v1/assets/')) return null;
            return parsed.toString();
        } catch (_) {
            return null;
        }
    }

    function safeKakaoUrl(value) {
        if (!value) return null;
        try {
            const parsed = new URL(value.replace(/^http:\/\//, 'https://'));
            if (parsed.protocol !== 'https:' || parsed.hostname !== 'pf.kakao.com') return null;
            return parsed.toString();
        } catch (_) {
            return null;
        }
    }

    async function openExternal(value) {
        const url = safeKakaoUrl(value);
        if (!url) return;
        try {
            const openUrl = window.__TAURI__?.opener?.openUrl;
            if (openUrl) await openUrl(url);
            else window.open(url, '_blank', 'noopener,noreferrer');
        } catch (error) {
            console.error('[campus] external URL open failed', error);
        }
    }

    function showImage(url, caption) {
        const dialog = document.getElementById('image-dialog');
        const image = document.getElementById('image-dialog-img');
        document.getElementById('image-dialog-caption').textContent = caption;
        image.src = url;
        image.alt = `${caption} 이미지`;
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
    }

    function imageButton(post, className) {
        const imageUrl = safeAssetUrl(post?.images?.[0]?.url);
        if (!imageUrl) return element('div', `${className} meal-image-empty`, '이미지 없음');
        const button = element('button', `${className} meal-image-btn`);
        button.type = 'button';
        button.setAttribute('aria-label', `${post.title ?? '식단'} 이미지 크게 보기`);
        const image = element('img');
        image.src = imageUrl;
        image.alt = post.title ?? '식단 이미지';
        image.loading = 'lazy';
        image.addEventListener('error', () => button.classList.add('image-load-failed'));
        button.append(image);
        button.addEventListener('click', () => showImage(imageUrl, post.title ?? '식단'));
        return button;
    }

    function originalPostButton(post) {
        const url = safeKakaoUrl(post?.permalink);
        if (!url) return null;
        const button = element('button', 'link-btn meal-post-link', '원문 보기');
        button.type = 'button';
        button.addEventListener('click', () => openExternal(url));
        return button;
    }

    function renderTodayMeal(post, period) {
        const label = period === 'lunch' ? '중식' : '석식';
        const card = element('article', 'meal-card today-meal-card');
        const header = element('div', 'meal-card-header');
        header.append(element('h3', null, label));
        const badge = element('span', 'status-badge', post ? '게시됨' : '게시 전');
        badge.dataset.tone = post ? 'success' : 'neutral';
        header.append(badge);
        card.append(header);

        if (!post) {
            card.classList.add('meal-card-empty');
            card.append(element('p', null, `오늘 ${label} 식단이 아직 게시되지 않았습니다.`));
            return card;
        }

        const content = element('div', 'today-meal-content');
        content.append(imageButton(post, 'today-meal-image'));
        const copy = element('div', 'meal-card-copy');
        copy.append(element('p', 'meal-menu-text', post.text || '메뉴 내용이 없습니다.'));
        const footer = element('div', 'meal-card-footer');
        if (post.publishedAt) footer.append(element('span', null, `게시 ${relativeTime(post.publishedAt)}`));
        const original = originalPostButton(post);
        if (original) footer.append(original);
        copy.append(footer);
        content.append(copy);
        card.append(content);
        return card;
    }

    function renderWeeklyPost(post) {
        const card = element('article', 'meal-card weekly-meal-card');
        const header = element('div', 'meal-card-header');
        header.append(element('h3', null, post.title ?? '주간 식단표'));
        const original = originalPostButton(post);
        if (original) header.append(original);
        card.append(header);
        card.append(imageButton(post, 'weekly-meal-image'));
        if (post.text) card.append(element('p', 'weekly-meal-text', post.text));
        return card;
    }

    function renderRecentPost(post) {
        const card = element('article', 'recent-meal-row');
        card.append(imageButton(post, 'recent-meal-image'));
        const copy = element('div', 'recent-meal-copy');
        copy.append(element('h3', null, post.title ?? '식단'));
        copy.append(element('p', null, post.text || '메뉴 내용이 없습니다.'));
        card.append(copy);
        const original = originalPostButton(post);
        if (original) card.append(original);
        return card;
    }

    function renderMeals(payload) {
        const meals = payload.data;
        showDataView('meals');
        const cached = state.sourceMode.meals === 'cache';
        setSourceState(
            'meals',
            cached ? '저장된 식단' : '최신 식단 확인됨',
            cached ? sourceCacheDetail('meals') : `마지막 수집 ${relativeTime(payload.lastCheckedAt)}`,
            cached ? 'warning' : 'success',
        );
        document.getElementById('today-date').textContent = formatToday();

        const dailyPosts = [...meals.dailyMenus].sort(
            (left, right) => Date.parse(right.publishedAt ?? 0) - Date.parse(left.publishedAt ?? 0),
        );
        const todayPosts = dailyPosts.filter(postIsToday);
        const lunch = todayPosts.find((post) => mealPeriod(post) === 'lunch') ?? null;
        const dinner = todayPosts.find((post) => mealPeriod(post) === 'dinner') ?? null;
        const todayContainer = document.getElementById('today-meals');
        todayContainer.replaceChildren(renderTodayMeal(lunch, 'lunch'), renderTodayMeal(dinner, 'dinner'));

        const weeklyContainer = document.getElementById('weekly-meals');
        weeklyContainer.replaceChildren();
        if (meals.pinnedMenus.length === 0) {
            weeklyContainer.append(element('div', 'inline-empty', '게시된 주간 식단표가 없습니다.'));
        } else {
            for (const post of meals.pinnedMenus) weeklyContainer.append(renderWeeklyPost(post));
        }

        const recentContainer = document.getElementById('recent-meals');
        recentContainer.replaceChildren();
        const recentPosts = dailyPosts.filter((post) => !postIsToday(post)).slice(0, 6);
        if (recentPosts.length === 0) {
            recentContainer.append(element('div', 'inline-empty', '최근 식단이 없습니다.'));
        } else {
            for (const post of recentPosts) recentContainer.append(renderRecentPost(post));
        }
    }

    function activateTab(tab) {
        if (!VALID_TABS.has(tab)) return;
        state.activeTab = tab;
        document.querySelectorAll('[data-campus-tab]').forEach((button) => {
            const active = button.dataset.campusTab === tab;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
        });
        document.querySelectorAll('.campus-panel').forEach((panel) => {
            panel.classList.toggle('active', panel.id === `tab-${tab}`);
        });
        const url = new URL(window.location.href);
        url.searchParams.set('tab', tab);
        window.history.replaceState(null, '', url);

        loadCachedTab(tab);
        if (!state.data[tab]) {
            const label = tab === 'laundry' ? '세탁기 현황' : '식단';
            showContentState(tab, `${label}을 불러오는 중입니다.`, null, false, true);
        } else {
            renderTab(tab);
        }
        refreshTab(tab, false);
        scheduleRefresh();
    }

    window.setCampusTab = (tab) => {
        if (!VALID_TABS.has(tab)) return;
        state.activeTab = tab;
        if (state.domReady) activateTab(tab);
    };

    function initialize() {
        state.domReady = true;
        document.querySelectorAll('[data-campus-tab]').forEach((button) => {
            button.addEventListener('click', () => activateTab(button.dataset.campusTab));
        });
        document.querySelectorAll('[data-laundry-filter]').forEach((button) => {
            button.addEventListener('click', () => {
                state.laundryFilter = button.dataset.laundryFilter;
                document.querySelectorAll('[data-laundry-filter]').forEach((candidate) => {
                    const active = candidate === button;
                    candidate.classList.toggle('active', active);
                    candidate.setAttribute('aria-pressed', String(active));
                });
                if (state.data.laundry) renderLaundry(state.data.laundry);
            });
        });
        document.getElementById('refresh-btn').addEventListener('click', () => refreshTab(state.activeTab, true));
        document.getElementById('laundry-info-btn').addEventListener('click', (event) => {
            const button = event.currentTarget;
            const note = document.getElementById('laundry-note');
            const expanded = button.getAttribute('aria-expanded') === 'true';
            button.setAttribute('aria-expanded', String(!expanded));
            note.hidden = expanded;
        });

        const dialog = document.getElementById('image-dialog');
        const closeDialog = () => {
            if (typeof dialog.close === 'function') dialog.close();
            else dialog.removeAttribute('open');
            document.getElementById('image-dialog-img').removeAttribute('src');
        };
        document.getElementById('image-dialog-close').addEventListener('click', closeDialog);
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) closeDialog();
        });

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) window.clearTimeout(state.refreshTimer);
            else refreshTab(state.activeTab, false);
        });
        window.addEventListener('focus', () => refreshTab(state.activeTab, false));
        activateTab(state.activeTab);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
    else initialize();
})();
