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
  type LaundrySnapshot,
  type MealPost,
  type MealsSnapshot,
} from "../campus-client";
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

const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

export function PublicInformation() {
  const [meals, retryMeals] = useCampusResource(getPublicMeals);
  const [laundry, retryLaundry] = useCampusResource(getPublicLaundry);

  return (
    <section className="campus-information" aria-label="생활 정보">
      <TabGroup>
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

function useCampusResource<T>(
  loadResource: () => Promise<CampusEnvelope<T>>,
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
    const intervalId = window.setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      activeRef.current = false;
      window.clearInterval(intervalId);
    };
  }, [load]);

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
        <p className="ui-empty-state">현재 세탁기 현황을 불러올 수 없어요.</p>
      </article>
    );
  }

  const { value } = resource;
  const appliances: Array<{
    machineId: string;
    appliance: LaundryAppliance;
  }> = [];
  for (const machine of laundryData.machines) {
    if (machine.washer !== null) {
      appliances.push({
        machineId: machine.id,
        appliance: machine.washer,
      });
    }
    if (machine.dryer !== null) {
      appliances.push({
        machineId: machine.id,
        appliance: machine.dryer,
      });
    }
  }
  const available = appliances.filter(({ appliance }) =>
    isLaundryApplianceAvailable(appliance),
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
      {appliances.length === 0 ? (
        <p
          className="ui-empty-state"
          aria-label="사용 가능 수 미확인"
        >
          확인된 기기가 없어 사용 가능 수를 알 수 없어요.
        </p>
      ) : (
        <>
          <div className="laundry-summary">
            <span>
              <strong>{available.length}</strong>
              <small>대 사용 가능</small>
            </span>
            <p>
              {available.length > 0
                ? "지금 사용할 수 있는 기기가 있어요."
                : "현재 바로 사용할 수 있는 기기가 없어요."}
            </p>
          </div>
          <div className="machine-grid">
            {laundryData.machines.map((machine) => (
              <article className="machine-card" key={machine.id}>
                <h3>{machineLabel(machine.id)}</h3>
                <LaundryApplianceRow
                  appliance={machine.dryer}
                  kind="dryer"
                />
                <LaundryApplianceRow
                  appliance={machine.washer}
                  kind="washer"
                />
              </article>
            ))}
          </div>
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

function LaundryApplianceRow({
  appliance,
  kind,
}: {
  readonly appliance: LaundryAppliance | null;
  readonly kind: LaundryAppliance["appliance"];
}) {
  const available =
    appliance !== null && isLaundryApplianceAvailable(appliance);
  return (
    <div className="machine-appliance">
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
