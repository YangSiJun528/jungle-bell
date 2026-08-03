import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Disclosure,
  DisclosureButton,
  DisclosurePanel,
  Tab,
  TabGroup,
  TabList,
  TabPanel,
  TabPanels,
} from "@headlessui/react";

import {
  getPublicLaundry,
  getPublicMeals,
  type CampusEnvelope,
  type LaundryAppliance,
  type LaundryMachine,
  type LaundrySnapshot,
  type MealPost,
  type MealsSnapshot,
} from "../campus-client";
import {
  assessLaundryCapacity,
  laundryCapacityDataIsReliable,
  laundryCapacityInputsAreComplete,
} from "../laundry-capacity";
import { isLaundryApplianceAvailable } from "../laundry-state";
import {
  currentKstServiceDate,
  deduplicateMealPosts,
  mealServiceDate,
} from "../meal-service-date";

type ResourceState<T> =
  | { readonly state: "loading" }
  | { readonly state: "error" }
  | {
      readonly state: "loaded";
      readonly value: CampusEnvelope<T>;
      readonly refreshState: "idle" | "refreshing" | "failed";
    };

const LAUNDRY_REFRESH_INTERVAL_MS = 30_000;
const MEALS_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
const LAUNDRY_TAB_INDEX = 0;
const MEALS_TAB_INDEX = 1;

export type InformationView = "laundry" | "meals";

export function PublicInformation({
  view,
}: {
  readonly view?: InformationView;
} = {}) {
  const [selectedTabIndex, setSelectedTabIndex] = useState(() =>
    typeof window === "undefined"
      ? LAUNDRY_TAB_INDEX
      : informationTabIndex(window.location.hash),
  );
  const [meals, retryMeals] = useCampusResource(
    getPublicMeals,
    MEALS_REFRESH_INTERVAL_MS,
  );
  const [laundry, retryLaundry] = useCampusResource(
    getPublicLaundry,
    LAUNDRY_REFRESH_INTERVAL_MS,
  );

  useEffect(() => {
    if (view !== undefined) {
      return;
    }
    const syncTabToHash = () => {
      setSelectedTabIndex(informationTabIndex(window.location.hash));
    };
    window.addEventListener("hashchange", syncTabToHash);
    return () => window.removeEventListener("hashchange", syncTabToHash);
  }, [view]);

  const selectTab = (index: number) => {
    const nextIndex =
      index === MEALS_TAB_INDEX ? MEALS_TAB_INDEX : LAUNDRY_TAB_INDEX;
    const nextHash =
      nextIndex === MEALS_TAB_INDEX ? "#meals" : "#laundry";
    setSelectedTabIndex(nextIndex);
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
  };

  if (view === "laundry") {
    return (
      <section className="campus-information" aria-label="세탁 정보">
        <LaundryCard resource={laundry} onRetry={retryLaundry} />
      </section>
    );
  }

  if (view === "meals") {
    return (
      <section className="campus-information" aria-label="급식 정보">
        <MealCard resource={meals} onRetry={retryMeals} />
      </section>
    );
  }

  return (
    <section className="campus-information" aria-label="생활 정보">
      <TabGroup selectedIndex={selectedTabIndex} onChange={selectTab}>
        <TabList className="ui-tabs campus-tabs" aria-label="생활 정보 종류">
          <Tab className="ui-tab">세탁</Tab>
          <Tab className="ui-tab">급식</Tab>
        </TabList>
        <TabPanels>
          <TabPanel className="ui-tab-panel">
            <LaundryCard resource={laundry} onRetry={retryLaundry} />
          </TabPanel>
          <TabPanel className="ui-tab-panel">
            <MealCard resource={meals} onRetry={retryMeals} />
          </TabPanel>
        </TabPanels>
      </TabGroup>
    </section>
  );
}

function informationTabIndex(hash: string): number {
  return hash === "#meals" ? MEALS_TAB_INDEX : LAUNDRY_TAB_INDEX;
}

function useCampusResource<T>(
  loadResource: () => Promise<CampusEnvelope<T>>,
  refreshIntervalMs: number,
): readonly [ResourceState<T>, () => void] {
  const [resource, setResource] = useState<ResourceState<T>>({
    state: "loading",
  });
  const activeRef = useRef(false);
  const inFlightRef = useRef(false);

  const load = useCallback(() => {
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    setResource((current) =>
      current.state === "loaded"
        ? { ...current, refreshState: "refreshing" }
        : { state: "loading" },
    );
    void loadResource()
      .then((value) => {
        if (activeRef.current) {
          setResource({
            state: "loaded",
            value,
            refreshState: "idle",
          });
        }
      })
      .catch(() => {
        if (activeRef.current) {
          setResource((current) =>
            current.state === "loaded"
              ? { ...current, refreshState: "failed" }
              : { state: "error" },
          );
        }
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  }, [loadResource]);

  useEffect(() => {
    activeRef.current = true;
    load();
    const intervalId = window.setInterval(load, refreshIntervalMs);
    return () => {
      activeRef.current = false;
      window.clearInterval(intervalId);
    };
  }, [load, refreshIntervalMs]);

  return [resource, load] as const;
}

function MealCard({
  resource,
  onRetry,
}: {
  resource: ResourceState<MealsSnapshot>;
  onRetry: () => void;
}) {
  if (resource.state === "loading") {
    return (
      <article id="meals" className="card information-card meal-card" aria-busy="true">
        <div className="eyebrow">급식</div>
        <h2>오늘의 식단</h2>
        <p className="ui-empty-state">식단을 불러오고 있어요.</p>
      </article>
    );
  }
  if (resource.state === "error") {
    return (
      <article id="meals" className="card information-card meal-card">
        <div className="eyebrow">급식</div>
        <h2>오늘의 식단</h2>
        <p className="ui-empty-state">현재 식단을 불러올 수 없어요.</p>
        <InitialLoadRetry
          label="급식"
          onRetry={onRetry}
        />
      </article>
    );
  }
  const mealData = resource.value.data;
  if (mealData === null) {
    return (
      <article id="meals" className="card information-card meal-card">
        <div className="eyebrow">급식</div>
        <h2>오늘의 식단</h2>
        <p className="ui-empty-state">현재 식단을 불러올 수 없어요.</p>
      </article>
    );
  }

  const { value } = resource;
  const today = currentKstServiceDate();
  const todayMenus = mealData.data.dailyMenus.filter(
    (menu) => mealServiceDate(menu, mealData.asOf) === today,
  );
  const menu = todayMenus[0] ?? null;
  const recentMenus = deduplicateMealPosts([
    ...mealData.data.dailyMenus.filter(
      (candidate) => mealServiceDate(candidate, mealData.asOf) !== today,
    ),
    ...mealData.data.recentMenus,
  ]);
  return (
    <article id="meals" className="card information-card meal-card">
      <header className="information-card__header">
        <div>
          <div className="eyebrow">급식</div>
          <h2>오늘의 식단</h2>
        </div>
        {value.stale ? <StaleBadge /> : null}
      </header>
      {menu ? (
        <>
          <div className="meal-current">
            <strong>{menu.title ?? "오늘 메뉴"}</strong>
            <p>{menu.text || "메뉴 내용이 아직 없어요."}</p>
          </div>
          <MealAlternatives menus={todayMenus.slice(1)} />
        </>
      ) : (
        <p className="ui-empty-state">
          오늘 식단이 아직 게시되지 않았어요.
        </p>
      )}
      <RecentMealList menus={recentMenus} />
      <DataTimestamp
        savedAt={value.savedAtEpochMs}
        lastCheckedAt={value.lastCheckedAtEpochMs}
      />
      <RefreshFeedback
        state={resource.refreshState}
        label="급식"
        onRetry={onRetry}
      />
    </article>
  );
}

function RecentMealList({ menus }: { menus: readonly MealPost[] }) {
  if (menus.length === 0) {
    return null;
  }
  return (
    <Disclosure as="section" className="recent-meals">
      <DisclosureButton className="disclosure-button">
        <span>최근 식단 보기</span>
        <span className="disclosure-chevron" aria-hidden="true">⌄</span>
      </DisclosureButton>
      <DisclosurePanel transition className="disclosure-panel">
        {menus.slice(0, 10).map((menu) => (
          <p key={`${menu.id}:${menu.publishedAt ?? "unknown"}`}>
            <strong>{menu.title ?? "식단"}</strong>
            <span>{menu.text || "메뉴 내용 없음"}</span>
          </p>
        ))}
      </DisclosurePanel>
    </Disclosure>
  );
}

function MealAlternatives({
  menus,
}: {
  menus: readonly MealPost[];
}) {
  if (menus.length === 0) {
    return null;
  }
  return (
    <div className="meal-alternatives" aria-label="다른 오늘 메뉴">
      {menus.slice(0, 2).map((menu) => (
        <p key={menu.id} className="muted">
          <strong>{menu.title ?? "추가 메뉴"}</strong>
          <span>{menu.text}</span>
        </p>
      ))}
    </div>
  );
}

function LaundryCard({
  resource,
  onRetry,
}: {
  resource: ResourceState<LaundrySnapshot>;
  onRetry: () => void;
}) {
  if (resource.state === "loading") {
    return (
      <article id="laundry" className="card information-card laundry-card" aria-busy="true">
        <div className="eyebrow">세탁</div>
        <h2>워시타워</h2>
        <p className="ui-empty-state">세탁기 현황을 불러오고 있어요.</p>
      </article>
    );
  }
  if (resource.state === "error") {
    return (
      <article id="laundry" className="card information-card laundry-card">
        <div className="eyebrow">세탁</div>
        <h2>워시타워</h2>
        <LaundryCapacitySummary men={null} women={null} />
        <p className="ui-empty-state">현재 세탁기 현황을 불러올 수 없어요.</p>
        <InitialLoadRetry label="세탁실" onRetry={onRetry} />
      </article>
    );
  }
  const laundryData = resource.value.data;
  if (laundryData === null) {
    return (
      <article id="laundry" className="card information-card laundry-card">
        <div className="eyebrow">세탁</div>
        <h2>워시타워</h2>
        <LaundryCapacitySummary men={null} women={null} />
        <p className="ui-empty-state">현재 세탁기 현황을 불러올 수 없어요.</p>
      </article>
    );
  }

  const { value } = resource;
  const hasReportedAppliances = laundryData.machines.some(
    (machine) => machine.washer !== null || machine.dryer !== null,
  );
  const reliabilityState = {
    collection: laundryData.quality.collection,
    lastError: value.lastError,
    nowEpochMs: Date.now(),
    refreshFailed: resource.refreshState === "failed",
    savedAtEpochMs: value.savedAtEpochMs,
    sourceFreshness: laundryData.quality.sourceFreshness,
    stale: value.stale,
  };
  const menReliable = laundryCapacityDataIsReliable({
    ...reliabilityState,
    hasData: laundryCapacityInputsAreComplete(
      laundryData.machines,
      "men",
    ),
  });
  const womenReliable = laundryCapacityDataIsReliable({
    ...reliabilityState,
    hasData: laundryCapacityInputsAreComplete(
      laundryData.machines,
      "women",
    ),
  });
  const menCapacity = assessLaundryCapacity(
    laundryData.machines,
    "men",
    menReliable,
  );
  const womenCapacity = assessLaundryCapacity(
    laundryData.machines,
    "women",
    womenReliable,
  );

  return (
    <article id="laundry" className="card information-card laundry-card">
      <header className="information-card__header">
        <div>
          <div className="eyebrow">세탁</div>
          <h2>워시타워</h2>
        </div>
        <span className="information-status">
          <i
            className={
              laundryData.quality.collection === "SUCCESS"
                ? "status-dot status-dot--success"
                : "status-dot status-dot--warning"
            }
            aria-hidden="true"
          />
          {laundryData.quality.collection === "SUCCESS"
            ? "기기 상태 확인됨"
            : "일부 상태만 확인됨"}
          {value.stale ? <StaleBadge /> : null}
        </span>
      </header>
      <LaundryCapacitySummary
        men={menCapacity.startableLoads}
        women={womenCapacity.startableLoads}
      />
      {!hasReportedAppliances ? (
        <p
          className="ui-empty-state"
          aria-label="사용 가능 수 미확인"
        >
          확인된 기기가 없어 사용 가능 수를 알 수 없어요.
        </p>
      ) : (
        <>
          <LaundryOverviewMatrix machines={laundryData.machines} />
          <Disclosure as="section" className="machine-details">
            <DisclosureButton className="disclosure-button machine-details__trigger">
              <span>기기별 상세 상태</span>
              <span className="disclosure-chevron" aria-hidden="true">⌄</span>
            </DisclosureButton>
            <DisclosurePanel transition className="disclosure-panel machine-details__panel">
              <div className="machine-grid">
                {sortLaundryMachines(laundryData.machines).map((machine) => {
                  const zone = laundryMachineZone(machine.id);
                  return (
                    <article
                      className={`machine-card machine-card--${zone}`}
                      key={machine.id}
                    >
                      <header className="machine-card__header">
                        <h3>{machineLabel(machine.id)}</h3>
                        <span className={`zone-badge zone-badge--${zone}`}>
                          {laundryZoneLabel(zone)}
                        </span>
                      </header>
                      <LaundryApplianceRow
                        appliance={machine.dryer}
                        kind="dryer"
                      />
                      <LaundryApplianceRow
                        appliance={machine.washer}
                        kind="washer"
                      />
                    </article>
                  );
                })}
              </div>
            </DisclosurePanel>
          </Disclosure>
        </>
      )}
      <DataTimestamp
        savedAt={value.savedAtEpochMs}
        lastCheckedAt={value.lastCheckedAtEpochMs}
      />
      <RefreshFeedback
        state={resource.refreshState}
        label="세탁실"
        onRetry={onRetry}
      />
    </article>
  );
}

function LaundryCapacitySummary({
  men,
  women,
}: {
  readonly men: number | null;
  readonly women: number | null;
}) {
  return (
    <section
      className="laundry-capacity"
      aria-label="세탁부터 건조까지 가능한 예상 횟수"
    >
      <header className="laundry-capacity__header">
        <div>
          <h3>지금 세탁해도 될까요?</h3>
          <p>세탁을 시작해 건조까지 이어갈 수 있는 예상 횟수예요.</p>
        </div>
      </header>
      <div className="laundry-capacity__grid">
        <p className="laundry-capacity__item laundry-capacity__item--men">
          <span><i aria-hidden="true" />남성 사용 가능</span>
          <strong>{capacityText(men)}</strong>
        </p>
        <p className="laundry-capacity__item laundry-capacity__item--women">
          <span><i aria-hidden="true" />여성 사용 가능</span>
          <strong>{capacityText(women)}</strong>
        </p>
      </div>
      <Disclosure as="div" className="laundry-capacity__method">
        <DisclosureButton className="laundry-capacity__method-button">
          <span>공용 6·7번 포함 · 산출 기준 보기</span>
          <span className="disclosure-chevron" aria-hidden="true">⌄</span>
        </DisclosureButton>
        <DisclosurePanel transition className="laundry-capacity__note">
          빈 세탁기와 60분 안에 비는 건조기에서 진행 중인 세탁물의
          건조 수요를 뺀 예상치예요. 공용 기기는 두 값에 모두
          포함되며, 실제 상황과 다를 수 있어요.
        </DisclosurePanel>
      </Disclosure>
    </section>
  );
}

function capacityText(value: number | null): string {
  return value === null ? "산출 불가" : `예상 ${value}회`;
}

type LaundryZone = "men" | "common" | "women" | "other";

function LaundryOverviewMatrix({
  machines,
}: {
  readonly machines: readonly LaundryMachine[];
}) {
  const sorted = sortLaundryMachines(machines);
  return (
    <section className="laundry-overview" aria-labelledby="laundry-overview-title">
      <header className="laundry-overview__header">
        <div>
          <h3 id="laundry-overview-title">한눈에 보기</h3>
          <p>남은 시간과 바로 사용할 수 있는 기기를 확인하세요.</p>
        </div>
        <ul className="laundry-zone-legend" aria-label="세탁실 구역 색상">
          {(["men", "common", "women"] as const).map((zone) => (
            <li key={zone} className={`laundry-zone-legend__${zone}`}>
              <i aria-hidden="true" />{laundryZoneLabel(zone)}
            </li>
          ))}
        </ul>
      </header>
      <div className="laundry-overview__scroller">
        <table>
          <caption className="sr-only">
            워시타워 번호별 건조기와 세탁기 상태
          </caption>
          <thead>
            <tr>
              <th scope="col">기기</th>
              {sorted.map((machine) => {
                const zone = laundryMachineZone(machine.id);
                return (
                  <th
                    className={`laundry-overview__number laundry-overview__number--${zone}`}
                    key={machine.id}
                    scope="col"
                  >
                    {machineNumber(machine.id) ?? machineLabel(machine.id)}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {(["dryer", "washer"] as const).map((kind) => {
              const appliances = sorted.map((machine) => machine[kind]);
              const available = appliances.filter(
                (appliance) =>
                  appliance !== null && isLaundryApplianceAvailable(appliance),
              ).length;
              const reported = appliances.filter(
                (appliance) => appliance !== null,
              ).length;
              return (
                <tr key={kind}>
                  <th scope="row">
                    {kind === "washer" ? "세탁기" : "건조기"}
                    <small><b>{available}</b>/{reported}</small>
                  </th>
                  {sorted.map((machine) => (
                    <LaundryOverviewCell
                      appliance={machine[kind]}
                      key={`${machine.id}:${kind}`}
                      kind={kind}
                      machine={machine}
                    />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LaundryOverviewCell({
  appliance,
  kind,
  machine,
}: {
  readonly appliance: LaundryAppliance | null;
  readonly kind: LaundryAppliance["appliance"];
  readonly machine: LaundryMachine;
}) {
  const zone = laundryMachineZone(machine.id);
  const tone = laundryApplianceTone(appliance);
  const text = laundryOverviewText(appliance);
  const applianceLabel = kind === "washer" ? "세탁기" : "건조기";
  const accessibleStatus = appliance === null ? "정보 없음" : applianceStatus(appliance);
  return (
    <td>
      <span
        className={`laundry-overview__cell laundry-overview__cell--${tone} laundry-overview__cell--${zone}`}
        title={`${machineLabel(machine.id)} ${applianceLabel}: ${accessibleStatus}`}
      >
        <span aria-hidden="true">{text}</span>
        <span className="sr-only">
          {machineLabel(machine.id)} {applianceLabel} {accessibleStatus}
        </span>
      </span>
    </td>
  );
}

function LaundryApplianceRow({
  appliance,
  kind,
}: {
  readonly appliance: LaundryAppliance | null;
  readonly kind: LaundryAppliance["appliance"];
}) {
  const available =
    appliance !== null && isLaundryApplianceAvailable(appliance);
  const progress = laundryProgress(appliance);
  const timing = laundryTiming(appliance);
  return (
    <div className="machine-appliance">
      <div className="machine-appliance__heading">
        <span>{kind === "washer" ? "세탁기" : "건조기"}</span>
        <strong
          className={
            available
              ? "ui-badge ui-badge--success"
              : appliance === null
                ? "ui-badge"
                : "ui-badge ui-badge--warning"
          }
        >
          {appliance === null ? "정보 없음" : applianceStatus(appliance)}
        </strong>
      </div>
      {timing ? <small className="machine-appliance__timing">{timing}</small> : null}
      {progress === null ? null : (
        <progress
          className="ui-progress machine-appliance__progress"
          max="100"
          value={progress}
          aria-label={`${kind === "washer" ? "세탁" : "건조"} 진행률`}
          aria-valuetext={`${Math.round(progress)}%`}
        />
      )}
    </div>
  );
}

function StaleBadge() {
  return <span className="ui-badge ui-badge--warning">업데이트 지연</span>;
}

function DataTimestamp({
  savedAt,
  lastCheckedAt,
  dark = false,
}: {
  savedAt: number | null;
  lastCheckedAt: number | null;
  dark?: boolean;
}) {
  if (savedAt === null && lastCheckedAt === null) {
    return null;
  }
  return (
    <p className={`data-timestamp${dark ? " dark" : ""}`}>
      {savedAt === null ? null : (
        <TimestampLine label="저장된 데이터" value={savedAt} />
      )}
      {savedAt !== null && lastCheckedAt !== null ? <br /> : null}
      {lastCheckedAt === null ? null : (
        <TimestampLine label="마지막 확인" value={lastCheckedAt} />
      )}
    </p>
  );
}

function TimestampLine({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  const iso = new Date(value).toISOString();
  return (
    <>
      {label} · {formatAge(value)} ·{" "}
      <time dateTime={iso}>{formatTimestamp(iso)}</time>
    </>
  );
}

function InitialLoadRetry({
  label,
  onRetry,
  dark = false,
}: {
  label: string;
  onRetry: () => void;
  dark?: boolean;
}) {
  return (
    <div
      className={dark ? "data-timestamp dark" : "data-timestamp"}
      role="status"
      aria-live="polite"
    >
      <span>최신 정보를 확인할 수 없어요. </span>
      <button
        className="ui-button ui-button--secondary ui-button--compact"
        type="button"
        aria-label={`${label} 다시 확인`}
        onClick={onRetry}
      >
        다시 확인
      </button>
    </div>
  );
}

function RefreshFeedback({
  state,
  label,
  onRetry,
  dark = false,
}: {
  state: "idle" | "refreshing" | "failed";
  label: string;
  onRetry: () => void;
  dark?: boolean;
}) {
  if (state === "idle") {
    return null;
  }
  return (
    <div
      className={dark ? "data-timestamp dark" : "data-timestamp"}
      role="status"
      aria-live="polite"
    >
      {state === "refreshing" ? (
        <span>새 정보를 확인하고 있어요.</span>
      ) : (
        <>
          <span>
            새 정보를 확인하지 못해 마지막으로 저장한 내용을 보여드려요.{" "}
          </span>
          <button
            className="ui-button ui-button--secondary ui-button--compact"
            type="button"
            aria-label={`${label} 다시 확인`}
            onClick={onRetry}
          >
            다시 확인
          </button>
        </>
      )}
    </div>
  );
}

function applianceStatus(appliance: LaundryAppliance): string {
  if (isLaundryApplianceAvailable(appliance)) {
    return "사용 가능";
  }
  if (
    appliance.operationalStatus === "ERROR" ||
    appliance.projection.status === "ERROR"
  ) {
    return "오류";
  }
  if (
    appliance.operationalStatus === "PAUSED" ||
    appliance.projection.status === "PAUSED"
  ) {
    return "일시 정지";
  }
  if (
    appliance.operationalStatus === "COMPLETED" ||
    appliance.projection.status === "COMPLETED"
  ) {
    return "동작 완료";
  }
  if (
    appliance.projection.remainingMinutes !== null &&
    appliance.projection.remainingMinutes > 0
  ) {
    return `${appliance.projection.remainingMinutes}분 남음`;
  }
  if (appliance.projection.status === "AWAITING_COMPLETION_CONFIRMATION") {
    return "완료 확인 중";
  }
  return "사용 중";
}

function laundryOverviewText(appliance: LaundryAppliance | null): string {
  if (appliance === null) {
    return "--";
  }
  if (isLaundryApplianceAvailable(appliance)) {
    return "가능";
  }
  if (
    appliance.operationalStatus === "ERROR" ||
    appliance.projection.status === "ERROR"
  ) {
    return "오류";
  }
  if (
    appliance.operationalStatus === "PAUSED" ||
    appliance.projection.status === "PAUSED"
  ) {
    return "정지";
  }
  const remaining =
    appliance.projection.remainingMinutes ?? appliance.remainingMinutes;
  if (remaining !== null && remaining > 0) {
    return `${remaining}분`;
  }
  if (
    appliance.operationalStatus === "COMPLETED" ||
    appliance.projection.status === "COMPLETED"
  ) {
    return "완료";
  }
  return "사용";
}

function laundryApplianceTone(
  appliance: LaundryAppliance | null,
): "available" | "busy" | "warning" | "danger" | "missing" {
  if (appliance === null) {
    return "missing";
  }
  if (isLaundryApplianceAvailable(appliance)) {
    return "available";
  }
  if (
    appliance.operationalStatus === "ERROR" ||
    appliance.projection.status === "ERROR"
  ) {
    return "danger";
  }
  if (
    appliance.operationalStatus === "PAUSED" ||
    appliance.projection.status === "PAUSED" ||
    appliance.projection.status === "AWAITING_COMPLETION_CONFIRMATION"
  ) {
    return "warning";
  }
  return "busy";
}

function laundryProgress(appliance: LaundryAppliance | null): number | null {
  if (appliance === null || isLaundryApplianceAvailable(appliance)) {
    return null;
  }
  const richAppliance = appliance as LaundryAppliance & {
    readonly totalMinutes?: number;
  };
  const total = richAppliance.totalMinutes;
  const remaining =
    appliance.projection.remainingMinutes ?? appliance.remainingMinutes;
  if (
    total === undefined ||
    !Number.isFinite(total) ||
    total <= 0 ||
    remaining === null ||
    !Number.isFinite(remaining)
  ) {
    return null;
  }
  return Math.max(0, Math.min(100, ((total - remaining) / total) * 100));
}

function laundryTiming(appliance: LaundryAppliance | null): string | null {
  if (appliance === null || isLaundryApplianceAvailable(appliance)) {
    return null;
  }
  const richAppliance = appliance as LaundryAppliance & {
    readonly estimatedFinishAt?: string | null;
    readonly startedAt?: string;
  };
  if (richAppliance.estimatedFinishAt) {
    return `${formatClock(richAppliance.estimatedFinishAt)} 종료 예정`;
  }
  if (richAppliance.startedAt) {
    return `${formatClock(richAppliance.startedAt)} 시작`;
  }
  return null;
}

function formatClock(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

function sortLaundryMachines(
  machines: readonly LaundryMachine[],
): readonly LaundryMachine[] {
  return [...machines].sort((left, right) => {
    const leftNumber = machineNumber(left.id);
    const rightNumber = machineNumber(right.id);
    if (leftNumber === null && rightNumber === null) {
      return left.id.localeCompare(right.id, "ko");
    }
    if (leftNumber === null) {
      return 1;
    }
    if (rightNumber === null) {
      return -1;
    }
    return leftNumber - rightNumber;
  });
}

function laundryMachineZone(id: string): LaundryZone {
  const number = machineNumber(id);
  if (number !== null && number >= 1 && number <= 5) {
    return "men";
  }
  if (number !== null && number >= 6 && number <= 7) {
    return "common";
  }
  if (number !== null && number >= 8 && number <= 9) {
    return "women";
  }
  return "other";
}

function laundryZoneLabel(zone: LaundryZone): string {
  switch (zone) {
    case "men":
      return "남성";
    case "common":
      return "공용";
    case "women":
      return "여성";
    case "other":
      return "기타";
  }
}

function machineNumber(value: string): number | null {
  const match = /(?:워시타워|wash tower)?[_\s-]*(\d+)$/iu.exec(value.trim());
  return match?.[1] ? Number(match[1]) : null;
}

function machineLabel(value: string): string {
  const normalized = value.replaceAll("_", " ").trim();
  const match = /(?:워시타워|wash tower)\s*(\d+)/iu.exec(normalized);
  return match ? `워시타워 ${match[1]}` : normalized;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

function formatAge(value: number): string {
  const elapsedMs = Math.max(0, Date.now() - value);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) {
    return "방금";
  }
  if (minutes < 60) {
    return `${minutes}분 전`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}시간 전`;
  }
  return `${Math.floor(hours / 24)}일 전`;
}
