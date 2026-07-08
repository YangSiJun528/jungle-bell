import {useCallback, useEffect, useMemo, useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {HStack} from '@astryxdesign/core/HStack';
import {Heading} from '@astryxdesign/core/Heading';
import {Layout, LayoutContent, LayoutFooter, LayoutHeader} from '@astryxdesign/core/Layout';
import {List, ListItem} from '@astryxdesign/core/List';
import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import {Selector} from '@astryxdesign/core/Selector';
import {Spinner} from '@astryxdesign/core/Spinner';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {Switch} from '@astryxdesign/core/Switch';
import {Text} from '@astryxdesign/core/Text';
import {Token} from '@astryxdesign/core/Token';
import {VStack} from '@astryxdesign/core/VStack';
import logoUrl from './assets/logo.png';
import trayOrangeUrl from './assets/tray-mini-orange.png';
import trayRedUrl from './assets/tray-mini-red.png';
import trayWhiteUrl from './assets/tray-mini-white.png';
import {
  notificationEndOptions,
  notificationIntervalOptions,
  notificationStartOptions,
} from './settingsOptions';
import {
  invokeCommand,
  listenLoginStatusChanged,
  messageDialog,
  type LoginStatus,
} from './tauri';

type OsValue = 'mac' | 'win';
type ScenarioValue = 'morning' | 'day' | 'night';

type NotificationSettings = {
  startEnabled: boolean;
  endEnabled: boolean;
  startHour: string;
  endHour: string;
  startInterval: string;
  endInterval: string;
};

const totalSteps = 6;
const loginStep = 1;
const scenarioStep = 4;
const scenarioOrder: ScenarioValue[] = ['morning', 'day', 'night'];

const initialNotificationSettings: NotificationSettings = {
  startEnabled: false,
  endEnabled: false,
  startHour: '4',
  endHour: '4',
  startInterval: '5',
  endInterval: '5',
};

const scenarios: Record<
  ScenarioValue,
  {
    icon: string;
    label: string;
    time: string;
    description: string;
  }
> = {
  morning: {
    icon: trayRedUrl,
    label: '출석 시작 가능',
    time: '09:24',
    description: '빨간 종은 출석 시작이 필요한 상태입니다. 출석 페이지를 열어 체크인해 주세요.',
  },
  day: {
    icon: trayWhiteUrl,
    label: '학습 중',
    time: '14:08',
    description: '흰색 종은 출석이 완료된 상태입니다. 별도 작업은 필요 없습니다.',
  },
  night: {
    icon: trayRedUrl,
    label: '출석 종료 가능',
    time: '23:30',
    description: '빨간 종은 출석 종료가 필요한 상태입니다. 출석 페이지를 열어 체크아웃해 주세요.',
  },
};

function commandErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function detectInitialOs(): OsValue {
  if (/Win/i.test(navigator.userAgent)) {
    return 'win';
  }
  return 'mac';
}

function nextScenario(current: ScenarioValue, delta: number) {
  const index = scenarioOrder.indexOf(current);
  return scenarioOrder[index + delta];
}

export function OnboardingApp() {
  const [step, setStep] = useState(0);
  const [currentOs, setCurrentOs] = useState<OsValue>(() => detectInitialOs());
  const [scenario, setScenario] = useState<ScenarioValue>('morning');
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings>(
    initialNotificationSettings,
  );
  const [loginStatus, setLoginStatus] = useState<LoginStatus>({
    dataLoaded: false,
    needsLogin: true,
  });
  const [completionPending, setCompletionPending] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingControls, setPendingControls] = useState<Set<string>>(() => new Set());

  const setPending = useCallback((key: string, pending: boolean) => {
    setPendingControls(current => {
      const next = new Set(current);
      if (pending) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }, []);

  const syncLoginStatus = useCallback(async () => {
    try {
      const status = await invokeCommand('get_login_status');
      setLoginStatus(status);
    } catch (loginError) {
      setError(`로그인 상태를 확인하지 못했습니다: ${commandErrorMessage(loginError)}`);
    }
  }, []);

  const refreshLoginStatus = useCallback(() => {
    invokeCommand('refresh_login_status').catch(refreshError => {
      setError(`로그인 상태 갱신을 요청하지 못했습니다: ${commandErrorMessage(refreshError)}`);
    });
    window.setTimeout(() => {
      syncLoginStatus();
    }, 1200);
  }, [syncLoginStatus]);

  useEffect(() => {
    let isMounted = true;
    let unlisten: (() => void) | null = null;

    listenLoginStatusChanged(status => {
      if (isMounted) {
        setLoginStatus(status);
      }
    })
      .then(nextUnlisten => {
        unlisten = nextUnlisten;
      })
      .catch(listenError => {
        setError(`로그인 상태 이벤트를 연결하지 못했습니다: ${commandErrorMessage(listenError)}`);
      });

    syncLoginStatus();

    return () => {
      isMounted = false;
      if (unlisten) {
        unlisten();
      }
    };
  }, [syncLoginStatus]);

  useEffect(() => {
    let isMounted = true;

    async function hydrateNotificationSettings() {
      try {
        const [
          startEnabled,
          endEnabled,
          startTime,
          startInterval,
          endTime,
          endInterval,
        ] = await Promise.all([
          invokeCommand('get_start_notification_enabled'),
          invokeCommand('get_end_notification_enabled'),
          invokeCommand('get_notification_start'),
          invokeCommand('get_start_notification_interval'),
          invokeCommand('get_notification_end'),
          invokeCommand('get_end_notification_interval'),
        ]);

        if (isMounted) {
          setNotificationSettings({
            startEnabled,
            endEnabled,
            startHour: String(startTime.hour),
            endHour: String(endTime.hour),
            startInterval: String(startInterval),
            endInterval: String(endInterval),
          });
        }
      } catch (settingsError) {
        setError(`알림 설정을 불러오지 못했습니다: ${commandErrorMessage(settingsError)}`);
      }
    }

    hydrateNotificationSettings();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (step !== loginStep || (loginStatus.dataLoaded && !loginStatus.needsLogin)) {
      return undefined;
    }

    refreshLoginStatus();
    const timer = window.setInterval(refreshLoginStatus, 5000);
    return () => window.clearInterval(timer);
  }, [loginStatus.dataLoaded, loginStatus.needsLogin, refreshLoginStatus, step]);

  const completeOnboarding = useCallback(async () => {
    if (completed || completionPending) {
      return;
    }

    setCompletionPending(true);
    setCompletionError(null);
    try {
      await invokeCommand('complete_onboarding');
      setCompleted(true);
    } catch (completeError) {
      setCompletionError(`완료 저장에 실패했습니다: ${commandErrorMessage(completeError)}`);
    } finally {
      setCompletionPending(false);
    }
  }, [completed, completionPending]);

  useEffect(() => {
    if (step === totalSteps - 1 && !completed && !completionPending && !completionError) {
      completeOnboarding();
    }
  }, [completeOnboarding, completed, completionError, completionPending, step]);

  const isNextDisabled =
    step === loginStep && (!loginStatus.dataLoaded || loginStatus.needsLogin);

  const setBooleanNotification = useCallback(
    async (
      key: keyof Pick<NotificationSettings, 'startEnabled' | 'endEnabled'>,
      command: 'set_start_notification_enabled' | 'set_end_notification_enabled',
      enabled: boolean,
    ) => {
      const previousValue = notificationSettings[key];
      setNotificationSettings(current => ({...current, [key]: enabled}));
      setPending(key, true);
      setError(null);
      try {
        await invokeCommand(command, {enabled});
      } catch (settingError) {
        setNotificationSettings(current => ({...current, [key]: previousValue}));
        setError(`알림 설정을 저장하지 못했습니다: ${commandErrorMessage(settingError)}`);
      } finally {
        setPending(key, false);
      }
    },
    [notificationSettings, setPending],
  );

  const setSelectorValue = useCallback(
    async (
      key: keyof Pick<
        NotificationSettings,
        'startHour' | 'endHour' | 'startInterval' | 'endInterval'
      >,
      command:
        | 'set_notification_start'
        | 'set_notification_end'
        | 'set_start_notification_interval'
        | 'set_end_notification_interval',
      value: string,
    ) => {
      const previousValue = notificationSettings[key];
      setNotificationSettings(current => ({...current, [key]: value}));
      setPending(key, true);
      setError(null);
      try {
        const numericValue = Number.parseInt(value, 10);
        if (command === 'set_notification_start' || command === 'set_notification_end') {
          await invokeCommand(command, {hour: numericValue, minute: 0});
        } else {
          await invokeCommand(command, {value: numericValue});
        }
      } catch (settingError) {
        setNotificationSettings(current => ({...current, [key]: previousValue}));
        setError(`알림 설정을 저장하지 못했습니다: ${commandErrorMessage(settingError)}`);
      } finally {
        setPending(key, false);
      }
    },
    [notificationSettings, setPending],
  );

  const openAttendanceWindow = useCallback(async () => {
    setPending('openAttendance', true);
    setError(null);
    try {
      await invokeCommand('open_attendance_window');
      refreshLoginStatus();
    } catch (openError) {
      setError(`출석 페이지를 열지 못했습니다: ${commandErrorMessage(openError)}`);
    } finally {
      setPending('openAttendance', false);
    }
  }, [refreshLoginStatus, setPending]);

  const openNotificationSettings = useCallback(async () => {
    setPending('openNotificationSettings', true);
    setError(null);
    try {
      await invokeCommand('open_notification_settings');
    } catch (settingsError) {
      const message = `시스템 알림 설정을 열지 못했습니다.\n${commandErrorMessage(settingsError)}`;
      setError(message);
      await messageDialog(message, {title: '알림 설정'});
    } finally {
      setPending('openNotificationSettings', false);
    }
  }, [setPending]);

  const goPrevious = useCallback(() => {
    if (step === scenarioStep) {
      const previousScenario = nextScenario(scenario, -1);
      if (previousScenario) {
        setScenario(previousScenario);
        return;
      }
    }
    setStep(current => Math.max(0, current - 1));
    if (step - 1 === scenarioStep) {
      setScenario('night');
    }
  }, [scenario, step]);

  const goNext = useCallback(() => {
    if (isNextDisabled) {
      return;
    }
    if (step === scenarioStep) {
      const followingScenario = nextScenario(scenario, 1);
      if (followingScenario) {
        setScenario(followingScenario);
        return;
      }
    }
    if (step < totalSteps - 1) {
      setStep(current => Math.min(totalSteps - 1, current + 1));
      return;
    }
    if (completionError) {
      completeOnboarding();
    }
  }, [completeOnboarding, completionError, isNextDisabled, scenario, step]);

  const content = useMemo(() => {
    if (step === 0) {
      const locationText =
        currentOs === 'mac' ? '메뉴 바 오른쪽에 있는' : '작업 표시줄 오른쪽에 있는';
      return (
        <VStack gap={4}>
          <VStack gap={1}>
            <Heading level={2}>트레이에서 출석 상태를 확인합니다</Heading>
            <Text>{locationText} Jungle Bell 아이콘을 클릭하면 출석 페이지와 설정을 열 수 있습니다.</Text>
          </VStack>
          <List density="compact" hasDividers header={<Heading level={3}>트레이 메뉴</Heading>}>
            <ListItem
              label="Jungle Bell 아이콘"
              description={currentOs === 'mac' ? 'macOS 메뉴 바 오른쪽' : 'Windows 작업 표시줄 오른쪽'}
              startContent={
                <>
                  {/* Existing tray asset; Astryx does not provide the product tray icon. */}
                  <img src={trayWhiteUrl} alt="" className="tray-asset-large" />
                </>
              }
            />
            <ListItem label="출석 페이지 열기" description="LMS 출석 페이지를 새 창으로 엽니다." />
            <ListItem label="식단표 보러가기" description="정글 식단표 페이지를 엽니다." />
            <ListItem label="설정" description="알림과 앱 실행 옵션을 조정합니다." />
          </List>
        </VStack>
      );
    }

    if (step === 1) {
      const statusVariant =
        !loginStatus.dataLoaded ? 'neutral' : loginStatus.needsLogin ? 'warning' : 'success';
      const statusLabel =
        !loginStatus.dataLoaded ? '로그인 확인 중' : loginStatus.needsLogin ? '로그인 필요' : '로그인 완료';

      return (
        <VStack gap={4}>
          <VStack gap={1}>
            <Heading level={2}>LMS 로그인을 확인합니다</Heading>
            <Text>로그인되어 있어야 Jungle Bell이 출석 상태를 확인할 수 있습니다.</Text>
          </VStack>
          <List density="compact" hasDividers header={<Heading level={3}>로그인 상태</Heading>}>
            <ListItem
              label={statusLabel}
              description={
                loginStatus.needsLogin
                  ? '출석 페이지를 열고 LMS 로그인을 완료한 뒤 이 화면으로 돌아오세요.'
                  : '다음 단계로 진행할 수 있습니다.'
              }
              startContent={<StatusDot variant={statusVariant} label={statusLabel} />}
              endContent={
                !loginStatus.dataLoaded ? (
                  <Spinner size="sm" aria-label="로그인 확인 중" />
                ) : loginStatus.needsLogin ? (
                  <Button
                    label="출석 페이지 열기"
                    size="sm"
                    variant="primary"
                    isLoading={pendingControls.has('openAttendance')}
                    clickAction={openAttendanceWindow}
                  />
                ) : (
                  <Token label="확인됨" color="green" size="sm" />
                )
              }
            />
          </List>
        </VStack>
      );
    }

    if (step === 2) {
      return (
        <VStack gap={4}>
          <VStack gap={1}>
            <Heading level={2}>알림 시간을 정합니다</Heading>
            <Text>필요한 알림만 켜도 됩니다. 설정에서 언제든 바꿀 수 있습니다.</Text>
          </VStack>
          <List density="compact" hasDividers header={<Heading level={3}>시작 출석 알림</Heading>}>
            <ListItem
              label="시작 출석 알림"
              endContent={
                <Switch
                  label="시작 출석 알림"
                  isLabelHidden
                  value={notificationSettings.startEnabled}
                  isLoading={pendingControls.has('startEnabled')}
                  onChange={checked =>
                    setBooleanNotification(
                      'startEnabled',
                      'set_start_notification_enabled',
                      checked,
                    )
                  }
                />
              }
            />
            <ListItem
              label="시간 범위"
              endContent={
                <Selector
                  label="시작 출석 시간 범위"
                  isLabelHidden
                  size="sm"
                  value={notificationSettings.startHour}
                  options={notificationStartOptions}
                  isDisabled={!notificationSettings.startEnabled}
                  onChange={value => setSelectorValue('startHour', 'set_notification_start', value)}
                />
              }
            />
            <ListItem
              label="알림 간격"
              endContent={
                <Selector
                  label="시작 출석 알림 간격"
                  isLabelHidden
                  size="sm"
                  value={notificationSettings.startInterval}
                  options={notificationIntervalOptions}
                  isDisabled={!notificationSettings.startEnabled}
                  onChange={value =>
                    setSelectorValue('startInterval', 'set_start_notification_interval', value)
                  }
                />
              }
            />
          </List>
          <List density="compact" hasDividers header={<Heading level={3}>종료 출석 알림</Heading>}>
            <ListItem
              label="종료 출석 알림"
              endContent={
                <Switch
                  label="종료 출석 알림"
                  isLabelHidden
                  value={notificationSettings.endEnabled}
                  isLoading={pendingControls.has('endEnabled')}
                  onChange={checked =>
                    setBooleanNotification('endEnabled', 'set_end_notification_enabled', checked)
                  }
                />
              }
            />
            <ListItem
              label="시간 범위"
              endContent={
                <Selector
                  label="종료 출석 시간 범위"
                  isLabelHidden
                  size="sm"
                  value={notificationSettings.endHour}
                  options={notificationEndOptions}
                  isDisabled={!notificationSettings.endEnabled}
                  onChange={value => setSelectorValue('endHour', 'set_notification_end', value)}
                />
              }
            />
            <ListItem
              label="알림 간격"
              endContent={
                <Selector
                  label="종료 출석 알림 간격"
                  isLabelHidden
                  size="sm"
                  value={notificationSettings.endInterval}
                  options={notificationIntervalOptions}
                  isDisabled={!notificationSettings.endEnabled}
                  onChange={value =>
                    setSelectorValue('endInterval', 'set_end_notification_interval', value)
                  }
                />
              }
            />
          </List>
        </VStack>
      );
    }

    if (step === 3) {
      return (
        <VStack gap={4}>
          <VStack gap={1}>
            <Heading level={2}>시스템 알림 권한을 확인합니다</Heading>
            <Text>알림을 받으려면 시스템 설정에서 Jungle Bell 알림을 허용해야 합니다.</Text>
          </VStack>
          <List density="compact" hasDividers header={<Heading level={3}>알림 권한</Heading>}>
            <ListItem
              label="시스템 알림 설정"
              description="사용자 기기의 설정에 따라 비활성화되어 있을 수 있습니다."
              endContent={
                <Button
                  label="설정 열기"
                  size="sm"
                  variant="primary"
                  isLoading={pendingControls.has('openNotificationSettings')}
                  clickAction={openNotificationSettings}
                />
              }
            />
          </List>
        </VStack>
      );
    }

    if (step === 4) {
      const selectedScenario = scenarios[scenario];
      return (
        <VStack gap={4}>
          <VStack gap={1}>
            <Heading level={2}>아이콘 색으로 상태를 봅니다</Heading>
            <Text>Jungle Bell 아이콘은 현재 출석 상태에 맞춰 바뀝니다.</Text>
          </VStack>
          <SegmentedControl
            label="출석 상태 예시"
            value={scenario}
            onChange={value => setScenario(value as ScenarioValue)}
            layout="fill">
            <SegmentedControlItem value="morning" label="시작 전" />
            <SegmentedControlItem value="day" label="학습 중" />
            <SegmentedControlItem value="night" label="종료 전" />
          </SegmentedControl>
          <List density="compact" hasDividers header={<Heading level={3}>상태 예시</Heading>}>
            <ListItem
              label={selectedScenario.label}
              description={`${selectedScenario.time} · ${selectedScenario.description}`}
              startContent={
                <>
                  {/* Existing tray status asset; Astryx does not provide Jungle Bell tray status images. */}
                  <img src={selectedScenario.icon} alt="" className="tray-asset-large" />
                </>
              }
            />
            <ListItem
              label="로그인 필요"
              description="주황색 종은 LMS 로그인 상태 확인이 필요하다는 뜻입니다."
              startContent={
                <>
                  {/* Existing tray status asset; Astryx does not provide Jungle Bell tray status images. */}
                  <img src={trayOrangeUrl} alt="" className="tray-asset-large" />
                </>
              }
            />
          </List>
        </VStack>
      );
    }

    return (
      <VStack gap={4}>
        <VStack gap={1}>
          <Heading level={2}>준비가 끝났습니다</Heading>
          <Text>
            {completed
              ? '완료됐습니다. 창을 직접 닫아 주세요.'
              : completionError
                ? '완료 저장에 실패했습니다. 다시 시도해 주세요.'
                : '완료 처리 중입니다.'}
          </Text>
        </VStack>
        {completionPending ? <Spinner label="완료 저장 중" /> : null}
        {completed ? <Token label="온보딩 완료" color="green" /> : null}
        {completionError ? <Banner status="error" title={completionError} /> : null}
      </VStack>
    );
  }, [
    completed,
    completionError,
    completionPending,
    currentOs,
    loginStatus,
    notificationSettings,
    openAttendanceWindow,
    openNotificationSettings,
    pendingControls,
    scenario,
    setBooleanNotification,
    setSelectorValue,
    step,
  ]);

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <HStack padding={3} gap={3} vAlign="center" hAlign="between" wrap="wrap">
            <HStack gap={3} vAlign="center">
              {/* Existing product logo asset; Astryx does not provide the Jungle Bell brand image. */}
              <img src={logoUrl} alt="Jungle Bell" className="brand-asset" />
              <VStack gap={0}>
                <Heading level={1}>Jungle Bell</Heading>
                <Text type="supporting">{step + 1} / {totalSteps}</Text>
              </VStack>
            </HStack>
            <SegmentedControl
              label="운영체제 선택"
              size="sm"
              value={currentOs}
              onChange={value => setCurrentOs(value as OsValue)}>
              <SegmentedControlItem value="mac" label="macOS" />
              <SegmentedControlItem value="win" label="Windows" />
            </SegmentedControl>
          </HStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent label="Jungle Bell 온보딩">
          <VStack padding={3} gap={4}>
            {error ? <Banner status="error" title={error} /> : null}
            {content}
          </VStack>
        </LayoutContent>
      }
      footer={
        <LayoutFooter hasDivider>
          <HStack padding={3} gap={2} hAlign="between" wrap="wrap">
            <Button
              label="이전"
              variant="secondary"
              isDisabled={step === 0}
              onClick={goPrevious}
            />
            <HStack gap={2} wrap="wrap">
              {step < totalSteps - 1 ? (
                <Button label="건너뛰기" variant="ghost" onClick={() => setStep(current => current + 1)} />
              ) : null}
              <Button
                label={
                  step === totalSteps - 1
                    ? completed
                      ? '완료됨'
                      : completionError
                        ? '다시 시도'
                        : '완료 중'
                    : '다음'
                }
                variant="primary"
                isDisabled={
                  step === totalSteps - 1
                    ? !completionError
                    : isNextDisabled
                }
                isLoading={step === totalSteps - 1 && completionPending}
                onClick={goNext}
              />
            </HStack>
          </HStack>
        </LayoutFooter>
      }
    />
  );
}
