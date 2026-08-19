import {useRef, type ReactNode} from 'react';
import {Link} from '@tanstack/react-router';
import type {LucideIcon} from 'lucide-react';
import {
    Bell,
    BellRing,
    CalendarCheck,
    Download,
    House,
    Settings,
    UtensilsCrossed,
    WashingMachine,
    X,
} from 'lucide-react';

import jungleBellLogo from '../../assets/logo.png';
import type {PlatformKind} from '@/platform/contracts';
import type {DashboardRoute} from '../routes';
import {Button} from '../../components/ui/button';
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarHeader,
    SidebarInset,
    SidebarMenu,
    SidebarMenuBadge,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarProvider,
    SidebarRail,
    SidebarTrigger,
    useSidebar,
} from '../../components/ui/sidebar';
import {
    Sheet,
    SheetClose,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
} from '../../components/ui/sheet';
import {cn} from '../../lib/utils';
import {
    DASHBOARD_ROUTE_META,
    dashboardNavigationRoutes,
    dashboardRoutePath,
    dashboardUtilityRoutes,
} from '../routes';
import {DashboardFooter} from './DashboardFooter';

export interface DashboardShellProps {
    platform: PlatformKind;
    activeRoute: DashboardRoute;
    navigate: (route: DashboardRoute) => void;
    unreadCount: number;
    notificationPanel?: {
        open: boolean;
        onOpenChange: (open: boolean) => void;
        content: ReactNode;
    };
    children: ReactNode;
}

const ROUTE_ICONS: Readonly<Record<DashboardRoute, LucideIcon>> = {
    home: House,
    attendance: CalendarCheck,
    laundry: WashingMachine,
    meals: UtensilsCrossed,
    notifications: Bell,
    connections: Settings,
    install: Download,
};

interface NavigationItemProps {
    route: DashboardRoute;
    activeRoute: DashboardRoute;
}

function SidebarNavigationItem({
    route,
    activeRoute,
}: NavigationItemProps) {
    const {setOpenMobile} = useSidebar();
    const meta = DASHBOARD_ROUTE_META[route];
    const active = route === activeRoute;
    const Icon = ROUTE_ICONS[route];

    return (
        <SidebarMenuItem>
            <SidebarMenuButton
                asChild
                isActive={active}
                tooltip={meta.label}
                className="h-10 gap-3 rounded-lg px-3 text-sidebar-foreground/70"
            >
                <Link
                    to={dashboardRoutePath(route)}
                    aria-current={active ? 'page' : undefined}
                    aria-label={meta.label}
                    data-dashboard-route={route}
                    onClick={() => {
                        setOpenMobile(false);
                    }}
                >
                    <Icon className="size-[1.125rem]" aria-hidden="true" strokeWidth={active ? 2.25 : 1.9}/>
                    <span>{meta.label}</span>
                </Link>
            </SidebarMenuButton>
        </SidebarMenuItem>
    );
}

function SidebarNotificationItem({
    open,
    onTriggerClick,
    unreadCount,
}: {
    open: boolean;
    onTriggerClick: (trigger: HTMLButtonElement) => void;
    unreadCount: number;
}) {
    const {setOpenMobile} = useSidebar();
    const unread = Math.max(0, unreadCount);
    const hasUnread = unread > 0;
    const Icon = hasUnread ? BellRing : Bell;
    const label = hasUnread ? `알림, 읽지 않은 알림 ${unread}개` : '알림';
    const badgeLabel = String(unread);

    return (
        <SidebarMenuItem>
            <SheetTrigger asChild>
                <SidebarMenuButton
                    type="button"
                    isActive={open}
                    tooltip={label}
                    aria-label={label}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    data-dashboard-route="notifications"
                    data-unread={hasUnread || undefined}
                    onClick={(event) => {
                        onTriggerClick(event.currentTarget);
                        setOpenMobile(false);
                    }}
                    className={cn(
                        'h-10 gap-3 rounded-lg px-3',
                        hasUnread ? 'pr-10' : undefined,
                        hasUnread && !open ? 'text-primary hover:text-primary' : 'text-sidebar-foreground/70',
                    )}
                >
                    <Icon className="size-[1.125rem]" aria-hidden="true" strokeWidth={open ? 2.25 : 1.9}/>
                    <span>알림</span>
                </SidebarMenuButton>
            </SheetTrigger>
            {hasUnread ? (
                <SidebarMenuBadge
                    aria-hidden="true"
                    className="top-1/2! -translate-y-1/2! rounded-full bg-primary text-primary-foreground peer-hover/menu-button:text-primary-foreground peer-data-[active=true]/menu-button:text-primary-foreground"
                >
                    {badgeLabel}
                </SidebarMenuBadge>
            ) : null}
        </SidebarMenuItem>
    );
}

function BottomNavigationItem({
    route,
    activeRoute,
}: NavigationItemProps) {
    const meta = DASHBOARD_ROUTE_META[route];
    const active = route === activeRoute;
    const Icon = ROUTE_ICONS[route];

    return (
        <Link
            to={dashboardRoutePath(route)}
            aria-current={active ? 'page' : undefined}
            aria-label={meta.label}
            data-dashboard-route={route}
            className={cn(
                'relative flex min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5',
                'text-xs font-medium leading-none transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
        >
            <Icon className="size-[1.125rem]" aria-hidden="true" strokeWidth={active ? 2.25 : 1.9}/>
            <span className="truncate">{meta.shortLabel}</span>
        </Link>
    );
}

function Brand() {
    const {setOpenMobile} = useSidebar();

    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <SidebarMenuButton
                    asChild
                    className="p-0! hover:bg-transparent! active:bg-transparent! data-[active=true]:bg-transparent!"
                    size="lg"
                    tooltip="Jungle Bell 홈"
                >
                    <Link
                        to={dashboardRoutePath('home')}
                        aria-label="Jungle Bell 홈"
                        onClick={() => {
                            setOpenMobile(false);
                        }}
                    >
                        <img src={jungleBellLogo} alt="" className="size-8 shrink-0" aria-hidden="true"/>
                        <span className="min-w-0 truncate text-sm font-semibold tracking-[-0.01em] group-data-[collapsible=icon]:hidden">
                            Jungle Bell
                        </span>
                    </Link>
                </SidebarMenuButton>
            </SidebarMenuItem>
        </SidebarMenu>
    );
}

function SidebarCollapseControl() {
    const {isMobile, openMobile, state} = useSidebar();
    const label = isMobile
        ? (openMobile ? '사이드바 닫기' : '사이드바 열기')
        : (state === 'expanded' ? '사이드바 접기' : '사이드바 펼치기');

    return <SidebarTrigger aria-label={label} title={label}/>;
}

function ShellTopSpacer({
    activeRoute,
    notificationPanelOpen,
    rememberNotificationTrigger,
    hasUnreadNotifications,
    notificationAriaLabel,
}: {
    activeRoute: DashboardRoute;
    notificationPanelOpen: boolean;
    rememberNotificationTrigger: (trigger: HTMLButtonElement) => void;
    hasUnreadNotifications: boolean;
    notificationAriaLabel: string;
}) {
    const NotificationIcon = hasUnreadNotifications ? BellRing : Bell;

    return (
        <div
            className="flex h-14 shrink-0 items-center gap-2 px-3 sm:h-16 sm:px-4 md:px-5 lg:px-6"
            data-shell-top-spacer="true"
        >
            <SidebarTrigger
                aria-label="사이드바 메뉴 열기"
                title="사이드바 메뉴 열기"
                className="bg-background md:hidden"
            />
            <div className="ml-auto flex items-center gap-2 md:hidden">
                <SheetTrigger asChild>
                    <Button
                        variant={notificationPanelOpen ? 'secondary' : 'outline'}
                        size="icon-sm"
                        className={cn(
                            'bg-background',
                            hasUnreadNotifications && !notificationPanelOpen ? 'text-primary' : undefined,
                        )}
                        aria-label={notificationAriaLabel}
                        aria-haspopup="dialog"
                        aria-expanded={notificationPanelOpen}
                        data-dashboard-route="notifications"
                        data-unread={hasUnreadNotifications || undefined}
                        onClick={(event) => rememberNotificationTrigger(event.currentTarget)}
                    >
                        <NotificationIcon className="size-4" aria-hidden="true"/>
                    </Button>
                </SheetTrigger>
                <Button
                    asChild
                    variant={activeRoute === 'connections' ? 'secondary' : 'outline'}
                    size="icon-sm"
                    className="bg-background"
                    aria-label="설정"
                    aria-current={activeRoute === 'connections' ? 'page' : undefined}
                    data-dashboard-route="connections"
                >
                    <Link to={dashboardRoutePath('connections')}>
                        <Settings className="size-4" aria-hidden="true"/>
                    </Link>
                </Button>
            </div>
        </div>
    );
}

function DashboardBottomNavigation({
    routes,
    activeRoute,
}: {
    routes: readonly DashboardRoute[];
    activeRoute: DashboardRoute;
}) {
    return (
        <nav
            className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/96 px-2 pb-[calc(env(safe-area-inset-bottom)+0.375rem)] pt-1.5 backdrop-blur supports-[backdrop-filter]:bg-background/88 md:hidden"
            aria-label="모바일 메뉴"
            data-navigation-group="primary"
        >
            <div
                className="mx-auto grid max-w-lg gap-1"
                style={{gridTemplateColumns: `repeat(${routes.length}, minmax(0, 1fr))`}}
            >
                {routes.map((route) => (
                    <BottomNavigationItem
                        key={route}
                        route={route}
                        activeRoute={activeRoute}
                    />
                ))}
            </div>
        </nav>
    );
}

export function DashboardShell({
    platform,
    activeRoute,
    navigate,
    unreadCount,
    notificationPanel,
    children,
}: DashboardShellProps) {
    const sidebarRoutes = dashboardNavigationRoutes();
    const bottomRoutes = dashboardNavigationRoutes();
    const utilityRoutes = dashboardUtilityRoutes();
    const normalizedUnreadCount = Math.max(0, unreadCount);
    const hasUnreadNotifications = normalizedUnreadCount > 0;
    const notificationAriaLabel = hasUnreadNotifications
        ? `${DASHBOARD_ROUTE_META.notifications.label}, 읽지 않은 알림 ${normalizedUnreadCount}개`
        : DASHBOARD_ROUTE_META.notifications.label;
    const notificationPanelOpen = notificationPanel?.open ?? activeRoute === 'notifications';
    const onNotificationPanelOpenChange = notificationPanel?.onOpenChange ?? ((open: boolean) => {
        if (open) navigate('notifications');
    });
    const notificationTriggerRef = useRef<HTMLButtonElement | null>(null);
    const rememberNotificationTrigger = (trigger: HTMLButtonElement): void => {
        notificationTriggerRef.current = trigger;
        onNotificationPanelOpenChange(true);
    };

    return (
        <Sheet open={notificationPanelOpen} onOpenChange={onNotificationPanelOpenChange}>
            <SidebarProvider
                resizable
                className="bg-muted/35 text-foreground"
                data-dashboard-shell="renewal"
                data-dashboard-platform={platform}
            >
            <button
                type="button"
                className="sr-only fixed left-3 top-3 z-[100] rounded-md bg-background px-3 py-2 text-sm font-medium shadow-lg focus:not-sr-only"
                onClick={() => document.getElementById('dashboard-content')?.focus()}
            >
                본문 바로가기
            </button>

            <Sidebar collapsible="icon">
                <SidebarHeader className="h-16 justify-center">
                    <Brand/>
                </SidebarHeader>

                <SidebarContent>
                    <SidebarGroup>
                        <SidebarGroupContent>
                            <nav aria-label="주요 메뉴" data-navigation-group="primary">
                                <SidebarMenu>
                                    {sidebarRoutes.map((route) => (
                                        <SidebarNavigationItem
                                            key={route}
                                            route={route}
                                            activeRoute={activeRoute}
                                        />
                                    ))}
                                </SidebarMenu>
                            </nav>
                        </SidebarGroupContent>
                    </SidebarGroup>
                </SidebarContent>

                <SidebarFooter className="border-t border-sidebar-border">
                    <nav aria-label="개인 도구" data-navigation-group="utilities">
                        <SidebarMenu>
                            {utilityRoutes.map((route) => (
                                route === 'notifications' ? (
                                    <SidebarNotificationItem
                                        key={route}
                                        open={notificationPanelOpen}
                                        onTriggerClick={rememberNotificationTrigger}
                                        unreadCount={unreadCount}
                                    />
                                ) : (
                                    <SidebarNavigationItem
                                        key={route}
                                        route={route}
                                        activeRoute={activeRoute}
                                    />
                                )
                            ))}
                        </SidebarMenu>
                    </nav>
                    <div className="flex justify-end group-data-[collapsible=icon]:justify-center">
                        <SidebarCollapseControl/>
                    </div>
                </SidebarFooter>
                <SidebarRail/>
            </Sidebar>

            <SidebarInset
                id="dashboard-content"
                tabIndex={-1}
                className="min-w-0 bg-muted/35"
            >
                <ShellTopSpacer
                    activeRoute={activeRoute}
                    notificationPanelOpen={notificationPanelOpen}
                    rememberNotificationTrigger={rememberNotificationTrigger}
                    hasUnreadNotifications={hasUnreadNotifications}
                    notificationAriaLabel={notificationAriaLabel}
                />
                <div className="mx-auto w-full max-w-6xl p-3 sm:p-4 md:p-5 lg:p-6">
                    {children}
                </div>
                <DashboardFooter/>
            </SidebarInset>

            <DashboardBottomNavigation
                routes={bottomRoutes}
                activeRoute={activeRoute}
            />

            {notificationPanel ? (
                <SheetContent
                    side="right"
                    showCloseButton={false}
                    overlayClassName="backdrop-blur-sm"
                    className="w-full gap-0 sm:max-w-xl"
                    aria-describedby={undefined}
                    data-notification-panel="true"
                    onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        if (notificationTriggerRef.current?.isConnected) {
                            notificationTriggerRef.current?.focus();
                        } else {
                            document.getElementById('dashboard-content')?.focus();
                        }
                        notificationTriggerRef.current = null;
                    }}
                >
                    <SheetHeader className="flex-row items-center justify-between border-b px-5 py-4">
                        <SheetTitle>알림</SheetTitle>
                        <SheetClose asChild>
                            <Button variant="ghost" size="icon-sm" aria-label="알림 패널 닫기">
                                <X className="size-4" aria-hidden="true"/>
                            </Button>
                        </SheetClose>
                    </SheetHeader>
                    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
                        {notificationPanel.content}
                    </div>
                </SheetContent>
            ) : null}
            </SidebarProvider>
        </Sheet>
    );
}
