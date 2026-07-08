import {useCallback, useEffect, useMemo, useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Divider} from '@astryxdesign/core/Divider';
import {HStack} from '@astryxdesign/core/HStack';
import {Heading} from '@astryxdesign/core/Heading';
import {Layout, LayoutContent, LayoutFooter, LayoutHeader} from '@astryxdesign/core/Layout';
import {Link} from '@astryxdesign/core/Link';
import {List, ListItem} from '@astryxdesign/core/List';
import {Selector} from '@astryxdesign/core/Selector';
import {Spinner} from '@astryxdesign/core/Spinner';
import {Switch} from '@astryxdesign/core/Switch';
import {Tab, TabList} from '@astryxdesign/core/TabList';
import {Text} from '@astryxdesign/core/Text';
import {VStack} from '@astryxdesign/core/VStack';
import logoUrl from './assets/logo.png';
import {
  notificationEndOptions,
  notificationIntervalOptions,
  notificationStartOptions,
} from './settingsOptions';
import {confirmDialog, invokeCommand, messageDialog, type SettingsSnapshot} from './tauri';

type TabValue = 'attendance' | 'notification' | 'app';

type SettingsState = {
  appVersion: string;
  pendingUpdate: string | null;
  autoStart: boolean;
  autoUpdate: boolean;
  showDday: boolean;
  usageAnalyticsEnabled: boolean;
  debugMode: boolean;
  skipAttendance: boolean;
  skipSunday: boolean;
  startNotificationEnabled: boolean;
  endNotificationEnabled: boolean;
  notificationStartHour: string;
  notificationEndHour: string;
  startNotificationInterval: string;
  endNotificationInterval: string;
};

const initialSettings: SettingsState = {
  appVersion: '',
  pendingUpdate: null,
  autoStart: false,
  autoUpdate: false,
  showDday: false,
  usageAnalyticsEnabled: false,
  debugMode: false,
  skipAttendance: false,
  skipSunday: false,
  startNotificationEnabled: false,
  endNotificationEnabled: false,
  notificationStartHour: '4',
  notificationEndHour: '4',
  startNotificationInterval: '5',
  endNotificationInterval: '5',
};

function settingsFromSnapshot(snapshot: SettingsSnapshot): SettingsState {
  return {
    appVersion: snapshot.appVersion,
    pendingUpdate: snapshot.pendingUpdate,
    autoStart: snapshot.autoStart,
    autoUpdate: snapshot.autoUpdate,
    showDday: snapshot.showDday,
    usageAnalyticsEnabled: snapshot.usageAnalyticsEnabled,
    debugMode: snapshot.debugMode,
    skipAttendance: snapshot.skipAttendance,
    skipSunday: snapshot.skipSunday,
    startNotificationEnabled: snapshot.startNotificationEnabled,
    endNotificationEnabled: snapshot.endNotificationEnabled,
    notificationStartHour: String(snapshot.notificationStart.hour),
    notificationEndHour: String(snapshot.notificationEnd.hour),
    startNotificationInterval: String(snapshot.startNotificationInterval),
    endNotificationInterval: String(snapshot.endNotificationInterval),
  };
}

function nextAttendanceDayHint() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const mm = String(tomorrow.getMonth() + 1).padStart(2, '0');
  const dd = String(tomorrow.getDate()).padStart(2, '0');
  return `내일(${mm}/${dd}) 출석 시작 시각에 자동으로 해제됩니다.`;
}

function commandErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type SectionListProps = {
  title: string;
  children: React.ReactNode;
};

function SectionList({title, children}: SectionListProps) {
  return (
    <List density="compact" hasDividers header={<Heading level={2}>{title}</Heading>}>
      {children}
    </List>
  );
}

export function App() {
  const [activeTab, setActiveTab] = useState<TabValue>('attendance');
  const [settings, setSettings] = useState<SettingsState>(initialSettings);
  const [isLoading, setIsLoading] = useState(true);
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

  const loadSettings = useCallback(async (options?: {showLoading?: boolean}) => {
    const showLoading = options?.showLoading ?? true;
    if (showLoading) {
      setIsLoading(true);
    }
    setError(null);
    try {
      const snapshot = await invokeCommand('get_settings');
      setSettings(settingsFromSnapshot(snapshot));
    } catch (loadError) {
      setError(`설정을 불러오지 못했습니다: ${commandErrorMessage(loadError)}`);
    } finally {
      if (showLoading) {
        setIsLoading(false);
      }
    }
  }, []);

  const refreshUpdateStatus = useCallback(async () => {
    try {
      const pendingUpdate = await invokeCommand('get_pending_update');
      setSettings(current => ({...current, pendingUpdate}));
    } catch (updateError) {
      setError(`업데이트 상태를 확인하지 못했습니다: ${commandErrorMessage(updateError)}`);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    const onFocus = () => {
      invokeCommand('log_from_js', {level: 'info', message: '[settings] window focus'});
      loadSettings({showLoading: false});
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadSettings]);

  useEffect(() => {
    if (activeTab === 'app') {
      refreshUpdateStatus();
    }
  }, [activeTab, refreshUpdateStatus]);

  const setBooleanSetting = useCallback(
    async (
      key: keyof Pick<
        SettingsState,
        | 'autoStart'
        | 'autoUpdate'
        | 'showDday'
        | 'usageAnalyticsEnabled'
        | 'debugMode'
        | 'skipAttendance'
        | 'skipSunday'
        | 'startNotificationEnabled'
        | 'endNotificationEnabled'
      >,
      enabled: boolean,
      command:
        | 'set_auto_start'
        | 'set_auto_update'
        | 'set_show_dday'
        | 'set_usage_analytics_enabled'
        | 'set_debug_mode'
        | 'set_skip_attendance'
        | 'set_skip_sunday'
        | 'set_start_notification_enabled'
        | 'set_end_notification_enabled',
    ) => {
      const previousValue = settings[key];
      setSettings(current => ({...current, [key]: enabled}));
      setPending(key, true);
      setError(null);
      try {
        if (command === 'set_debug_mode' && enabled) {
          const confirmed = await confirmDialog(
            '디버그 모드를 활성화하면 API 요청/응답 데이터, 앱 내부 상태 등 상세 로그가 기록됩니다.\n로그 파일 크기가 빠르게 증가할 수 있으며, 문제 해결 후에는 비활성화를 권장합니다.',
            {title: '디버그 모드 활성화', okLabel: '활성화', cancelLabel: '취소'},
          );
          if (!confirmed) {
            setSettings(current => ({...current, [key]: previousValue}));
            return;
          }
        }
        await invokeCommand(command, {enabled});
      } catch (settingError) {
        setSettings(current => ({...current, [key]: previousValue}));
        setError(`설정을 저장하지 못했습니다: ${commandErrorMessage(settingError)}`);
      } finally {
        setPending(key, false);
      }
    },
    [setPending, settings],
  );

  const setSelectorValue = useCallback(
    async (
      key: keyof Pick<
        SettingsState,
        | 'notificationStartHour'
        | 'notificationEndHour'
        | 'startNotificationInterval'
        | 'endNotificationInterval'
      >,
      value: string,
      command:
        | 'set_notification_start'
        | 'set_notification_end'
        | 'set_start_notification_interval'
        | 'set_end_notification_interval',
    ) => {
      const previousValue = settings[key];
      setSettings(current => ({...current, [key]: value}));
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
        setSettings(current => ({...current, [key]: previousValue}));
        setError(`설정을 저장하지 못했습니다: ${commandErrorMessage(settingError)}`);
      } finally {
        setPending(key, false);
      }
    },
    [setPending, settings],
  );

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

  const runSimpleCommand = useCallback(
    async (
      key: string,
      command: 'open_log_folder' | 'open_onboarding' | 'check_and_notify_update',
    ) => {
      setPending(key, true);
      setError(null);
      try {
        await invokeCommand(command);
        if (command === 'check_and_notify_update') {
          await refreshUpdateStatus();
        }
      } catch (commandError) {
        setError(`요청을 처리하지 못했습니다: ${commandErrorMessage(commandError)}`);
      } finally {
        setPending(key, false);
      }
    },
    [refreshUpdateStatus, setPending],
  );

  const selectedTabContent = useMemo(() => {
    if (activeTab === 'attendance') {
      return (
        <VStack gap={4}>
          <SectionList title="출석 시간">
            <ListItem label="학습 시작" description="04:00 ~ 10:00" />
            <ListItem label="학습 종료" description="23:00 ~ 04:00" />
          </SectionList>
          <SectionList title="이번 출석">
            <ListItem
              label="이번 출석 알림 끄기"
              description={settings.skipAttendance ? nextAttendanceDayHint() : '이번 출석 주기에서만 알림을 끕니다.'}
              endContent={
                <Switch
                  label="이번 출석 알림 끄기"
                  isLabelHidden
                  value={settings.skipAttendance}
                  isLoading={pendingControls.has('skipAttendance')}
                  onChange={checked =>
                    setBooleanSetting('skipAttendance', checked, 'set_skip_attendance')
                  }
                />
              }
            />
          </SectionList>
        </VStack>
      );
    }

    if (activeTab === 'notification') {
      return (
        <VStack gap={4}>
          <SectionList title="알림 예외">
            <ListItem
              label="일요일 알림 끄기"
              endContent={
                <Switch
                  label="일요일 알림 끄기"
                  isLabelHidden
                  value={settings.skipSunday}
                  isLoading={pendingControls.has('skipSunday')}
                  onChange={checked => setBooleanSetting('skipSunday', checked, 'set_skip_sunday')}
                />
              }
            />
          </SectionList>
          <SectionList title="시작 출석">
            <ListItem
              label="시작 출석 알림"
              description="시작 체크를 하지 않으면 10:00 이후에도 알림이 발송됩니다."
              endContent={
                <Switch
                  label="시작 출석 알림"
                  isLabelHidden
                  value={settings.startNotificationEnabled}
                  isLoading={pendingControls.has('startNotificationEnabled')}
                  onChange={checked =>
                    setBooleanSetting(
                      'startNotificationEnabled',
                      checked,
                      'set_start_notification_enabled',
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
                  value={settings.notificationStartHour}
                  options={notificationStartOptions}
                  isDisabled={!settings.startNotificationEnabled}
                  onChange={value =>
                    setSelectorValue('notificationStartHour', value, 'set_notification_start')
                  }
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
                  value={settings.startNotificationInterval}
                  options={notificationIntervalOptions}
                  isDisabled={!settings.startNotificationEnabled}
                  onChange={value =>
                    setSelectorValue(
                      'startNotificationInterval',
                      value,
                      'set_start_notification_interval',
                    )
                  }
                />
              }
            />
          </SectionList>
          <SectionList title="종료 출석">
            <ListItem
              label="종료 출석 알림"
              endContent={
                <Switch
                  label="종료 출석 알림"
                  isLabelHidden
                  value={settings.endNotificationEnabled}
                  isLoading={pendingControls.has('endNotificationEnabled')}
                  onChange={checked =>
                    setBooleanSetting(
                      'endNotificationEnabled',
                      checked,
                      'set_end_notification_enabled',
                    )
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
                  value={settings.notificationEndHour}
                  options={notificationEndOptions}
                  isDisabled={!settings.endNotificationEnabled}
                  onChange={value =>
                    setSelectorValue('notificationEndHour', value, 'set_notification_end')
                  }
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
                  value={settings.endNotificationInterval}
                  options={notificationIntervalOptions}
                  isDisabled={!settings.endNotificationEnabled}
                  onChange={value =>
                    setSelectorValue(
                      'endNotificationInterval',
                      value,
                      'set_end_notification_interval',
                    )
                  }
                />
              }
            />
          </SectionList>
          <SectionList title="시스템 알림">
            <ListItem
              label="시스템 알림"
              description="알림이 오지 않으면 시스템 설정에서 Jungle Bell을 허용해 주세요."
              endContent={
                <Button
                  label="설정 열기"
                  size="sm"
                  variant="ghost"
                  isLoading={pendingControls.has('openNotificationSettings')}
                  clickAction={openNotificationSettings}
                />
              }
            />
          </SectionList>
        </VStack>
      );
    }

    return (
      <VStack gap={4}>
        {settings.pendingUpdate ? (
          <Banner
            status="info"
            title={`v${settings.pendingUpdate} 업데이트가 있습니다`}
            endContent={
              <Button
                label="지금 업데이트"
                size="sm"
                variant="primary"
                isLoading={pendingControls.has('updateNow')}
                clickAction={() => runSimpleCommand('updateNow', 'check_and_notify_update')}
              />
            }
          />
        ) : null}
        <SectionList title="앱 실행">
          <ListItem
            label="자동 시작"
            endContent={
              <Switch
                label="자동 시작"
                isLabelHidden
                value={settings.autoStart}
                isLoading={pendingControls.has('autoStart')}
                onChange={checked => setBooleanSetting('autoStart', checked, 'set_auto_start')}
              />
            }
          />
          <ListItem
            label="자동 업데이트"
            endContent={
              <Switch
                label="자동 업데이트"
                isLabelHidden
                value={settings.autoUpdate}
                isLoading={pendingControls.has('autoUpdate')}
                onChange={checked => setBooleanSetting('autoUpdate', checked, 'set_auto_update')}
              />
            }
          />
          <ListItem
            label="업데이트 확인"
            endContent={
              <Button
                label="업데이트 확인"
                size="sm"
                variant="ghost"
                isLoading={pendingControls.has('checkUpdate')}
                clickAction={() => runSimpleCommand('checkUpdate', 'check_and_notify_update')}
              />
            }
          />
        </SectionList>
        <SectionList title="개인정보와 진단">
          <ListItem
            label="사용 통계"
            description="개인적인 내용 없이 사용 통계만 보내요. 앱 개선에만 사용돼요."
            endContent={
              <Switch
                label="사용 통계"
                isLabelHidden
                value={settings.usageAnalyticsEnabled}
                isLoading={pendingControls.has('usageAnalyticsEnabled')}
                onChange={checked =>
                  setBooleanSetting(
                    'usageAnalyticsEnabled',
                    checked,
                    'set_usage_analytics_enabled',
                  )
                }
              />
            }
          />
          <ListItem
            label="디버그 모드"
            endContent={
              <Switch
                label="디버그 모드"
                isLabelHidden
                value={settings.debugMode}
                isLoading={pendingControls.has('debugMode')}
                onChange={checked => setBooleanSetting('debugMode', checked, 'set_debug_mode')}
              />
            }
          />
          <ListItem
            label="로그 폴더"
            endContent={
              <Button
                label="열기"
                size="sm"
                variant="ghost"
                isLoading={pendingControls.has('openLogFolder')}
                clickAction={() => runSimpleCommand('openLogFolder', 'open_log_folder')}
              />
            }
          />
        </SectionList>
        <SectionList title="표시와 시작하기">
          <ListItem
            label="온보딩"
            endContent={
              <Button
                label="다시 보기"
                size="sm"
                variant="ghost"
                isLoading={pendingControls.has('openOnboarding')}
                clickAction={() => runSimpleCommand('openOnboarding', 'open_onboarding')}
              />
            }
          />
          <ListItem
            label="D-Day 표시"
            endContent={
              <Switch
                label="D-Day 표시"
                isLabelHidden
                value={settings.showDday}
                isLoading={pendingControls.has('showDday')}
                onChange={checked => setBooleanSetting('showDday', checked, 'set_show_dday')}
              />
            }
          />
        </SectionList>
      </VStack>
    );
  }, [
    activeTab,
    openNotificationSettings,
    pendingControls,
    runSimpleCommand,
    setBooleanSetting,
    setSelectorValue,
    settings,
  ]);

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <HStack padding={3} gap={3} vAlign="center" hAlign="between">
            <HStack gap={3} vAlign="center">
              {/* Existing product logo asset; Astryx does not provide the Jungle Bell brand image. */}
              <img src={logoUrl} alt="Jungle Bell" className="brand-asset" />
              <VStack gap={0}>
                <Heading level={1}>Jungle Bell</Heading>
                <Text type="supporting">크래프톤 정글 출석 체크 리마인더</Text>
              </VStack>
            </HStack>
            {settings.appVersion ? <Text type="supporting">v{settings.appVersion}</Text> : null}
          </HStack>
          <TabList value={activeTab} onChange={value => setActiveTab(value as TabValue)} layout="fill" hasDivider>
            <Tab value="attendance" label="출석" />
            <Tab value="notification" label="알림" />
            <Tab value="app" label="앱" />
          </TabList>
        </LayoutHeader>
      }
      content={
        <LayoutContent label="Jungle Bell 설정">
          <VStack padding={3} gap={4}>
            {error ? <Banner status="error" title={error} /> : null}
            {isLoading ? <Spinner label="설정을 불러오는 중" /> : selectedTabContent}
          </VStack>
        </LayoutContent>
      }
      footer={
        <LayoutFooter hasDivider>
          <HStack padding={2} gap={2} hAlign="center" wrap="wrap">
            <Link href="https://github.com/YangSiJun528/jungle-bell" isExternalLink isStandalone>
              GitHub
            </Link>
            <Divider orientation="vertical" />
            <Link
              href="https://github.com/YangSiJun528/jungle-bell/releases"
              isExternalLink
              isStandalone>
              릴리즈
            </Link>
            <Divider orientation="vertical" />
            <Link
              href="https://github.com/YangSiJun528/jungle-bell/issues/new/choose"
              isExternalLink
              isStandalone>
              버그/기능 제보
            </Link>
          </HStack>
        </LayoutFooter>
      }
    />
  );
}
