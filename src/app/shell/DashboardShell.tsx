import type {ReactNode} from 'react';
import type {LucideIcon} from 'lucide-react';
import {
    Bell,
    BellRing,
    CalendarCheck,
    House,
    Monitor,
    UtensilsCrossed,
    WashingMachine,
} from 'lucide-react';

import type {DashboardRoute, DashboardSurfaceKind} from '../surface';
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
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarProvider,
    SidebarRail,
    SidebarSeparator,
    SidebarTrigger,
    useSidebar,
} from '../../components/ui/sidebar';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '../../components/ui/tooltip';
import {cn} from '../../lib/utils';
import {
    DASHBOARD_ROUTE_META,
    dashboardNavigationRoutes,
    dashboardRouteHref,
    dashboardUtilityRoutes,
} from '../routes';
import {DashboardFooter} from './DashboardFooter';

export interface DashboardShellProps {
    surface: DashboardSurfaceKind;
    activeRoute: DashboardRoute;
    navigate: (route: DashboardRoute) => void;
    unreadCount: number;
    children: ReactNode;
}

const ROUTE_ICONS: Readonly<Record<DashboardRoute, LucideIcon>> = {
    home: House,
    attendance: CalendarCheck,
    laundry: WashingMachine,
    meals: UtensilsCrossed,
    notifications: Bell,
    connections: Monitor,
};

interface NavigationItemProps {
    route: DashboardRoute;
    activeRoute: DashboardRoute;
    navigate: (route: DashboardRoute) => void;
    unreadCount: number;
}

function SidebarNavigationItem({
    route,
    activeRoute,
    navigate,
    unreadCount,
}: NavigationItemProps) {
    const meta = DASHBOARD_ROUTE_META[route];
    const active = route === activeRoute;
    const unread = route === 'notifications' ? Math.max(0, unreadCount) : 0;
    const hasUnread = unread > 0;
    const Icon = route === 'notifications' && hasUnread ? BellRing : ROUTE_ICONS[route];
    const ariaLabel = hasUnread ? `${meta.label}, 읽지 않은 알림 ${unread}개` : meta.label;

    return (
        <SidebarMenuItem>
            <SidebarMenuButton
                asChild
                isActive={active}
                tooltip={ariaLabel}
                className={cn(
                    'h-10 gap-3 rounded-lg px-3 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2!',
                    hasUnread && !active ? 'text-primary hover:text-primary' : 'text-sidebar-foreground/70',
                )}
            >
                <a
                    href={dashboardRouteHref(route)}
                    aria-current={active ? 'page' : undefined}
                    aria-label={ariaLabel}
                    data-dashboard-route={route}
                    data-unread={hasUnread || undefined}
                    onClick={(event) => {
                        event.preventDefault();
                        navigate(route);
                    }}
                >
                    <Icon className="size-[1.125rem]" aria-hidden="true" strokeWidth={active ? 2.25 : 1.9}/>
                    <span>{meta.label}</span>
                </a>
            </SidebarMenuButton>
        </SidebarMenuItem>
    );
}

function BottomNavigationItem({
    route,
    activeRoute,
    navigate,
}: Omit<NavigationItemProps, 'unreadCount'>) {
    const meta = DASHBOARD_ROUTE_META[route];
    const active = route === activeRoute;
    const Icon = ROUTE_ICONS[route];

    return (
        <a
            href={dashboardRouteHref(route)}
            aria-current={active ? 'page' : undefined}
            aria-label={meta.label}
            data-dashboard-route={route}
            onClick={(event) => {
                event.preventDefault();
                navigate(route);
            }}
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
        </a>
    );
}

function Brand({navigate}: Pick<DashboardShellProps, 'navigate'>) {
    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <SidebarMenuButton asChild size="lg" tooltip="Jungle Bell 홈" className="p-0!">
                    <a
                        href={dashboardRouteHref('home')}
                        aria-label="Jungle Bell 홈"
                        onClick={(event) => {
                            event.preventDefault();
                            navigate('home');
                        }}
                    >
                        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground shadow-xs">
                            <BellRing className="size-[1.125rem]" aria-hidden="true" strokeWidth={2}/>
                        </span>
                        <span className="min-w-0 truncate text-sm font-semibold tracking-[-0.01em] group-data-[collapsible=icon]:hidden">
                            Jungle Bell
                        </span>
                    </a>
                </SidebarMenuButton>
            </SidebarMenuItem>
        </SidebarMenu>
    );
}

function SidebarCollapseControl() {
    const {state} = useSidebar();
    const label = state === 'expanded' ? '사이드바 접기' : '사이드바 펼치기';

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <SidebarTrigger aria-label={label} title={label}/>
            </TooltipTrigger>
            <TooltipContent side="right" align="center">{label}</TooltipContent>
        </Tooltip>
    );
}

function ShellTopSpacer({
    personal,
    activeRoute,
    navigate,
    hasUnreadNotifications,
    notificationAriaLabel,
}: {
    personal: boolean;
    activeRoute: DashboardRoute;
    navigate: (route: DashboardRoute) => void;
    hasUnreadNotifications: boolean;
    notificationAriaLabel: string;
}) {
    const NotificationIcon = hasUnreadNotifications ? BellRing : Bell;

    return (
        <div
            className="flex h-14 shrink-0 items-center justify-end gap-2 px-3 sm:h-16 sm:px-4 md:px-5 lg:px-6"
            data-shell-top-spacer="true"
            aria-hidden={personal ? undefined : true}
        >
            {personal ? (
                <div className="flex items-center gap-2 md:hidden">
                    <Button
                        variant={activeRoute === 'notifications' ? 'secondary' : 'outline'}
                        size="icon-sm"
                        className={cn(
                            'bg-background',
                            hasUnreadNotifications && activeRoute !== 'notifications' ? 'text-primary' : undefined,
                        )}
                        aria-label={notificationAriaLabel}
                        aria-current={activeRoute === 'notifications' ? 'page' : undefined}
                        data-dashboard-route="notifications"
                        data-unread={hasUnreadNotifications || undefined}
                        onClick={() => navigate('notifications')}
                    >
                        <NotificationIcon className="size-4" aria-hidden="true"/>
                    </Button>
                    <Button
                        variant={activeRoute === 'connections' ? 'secondary' : 'outline'}
                        size="icon-sm"
                        className="bg-background"
                        aria-label="기기 연결 관리"
                        aria-current={activeRoute === 'connections' ? 'page' : undefined}
                        data-dashboard-route="connections"
                        onClick={() => navigate('connections')}
                    >
                        <Monitor className="size-4" aria-hidden="true"/>
                    </Button>
                </div>
            ) : null}
        </div>
    );
}

function DashboardBottomNavigation({
    routes,
    activeRoute,
    navigate,
}: {
    routes: readonly DashboardRoute[];
    activeRoute: DashboardRoute;
    navigate: (route: DashboardRoute) => void;
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
                        navigate={navigate}
                    />
                ))}
            </div>
        </nav>
    );
}

export function DashboardShell({
    surface,
    activeRoute,
    navigate,
    unreadCount,
    children,
}: DashboardShellProps) {
    const sidebarRoutes = dashboardNavigationRoutes(surface, 'sidebar');
    const bottomRoutes = dashboardNavigationRoutes(surface, 'bottom');
    const utilityRoutes = dashboardUtilityRoutes(surface);
    const personal = surface !== 'public';
    const normalizedUnreadCount = Math.max(0, unreadCount);
    const hasUnreadNotifications = normalizedUnreadCount > 0;
    const notificationAriaLabel = hasUnreadNotifications
        ? `${DASHBOARD_ROUTE_META.notifications.label}, 읽지 않은 알림 ${normalizedUnreadCount}개`
        : DASHBOARD_ROUTE_META.notifications.label;

    return (
        <SidebarProvider
            sidebarWidth="14.5rem"
            sidebarWidthIcon="3rem"
            className="bg-muted/35 text-foreground"
            data-dashboard-shell="renewal"
            data-dashboard-surface={surface}
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
                    <Brand navigate={navigate}/>
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
                                            navigate={navigate}
                                            unreadCount={unreadCount}
                                        />
                                    ))}
                                </SidebarMenu>
                            </nav>
                        </SidebarGroupContent>
                    </SidebarGroup>
                </SidebarContent>

                <SidebarFooter className="border-t border-sidebar-border">
                    {personal ? (
                        <nav aria-label="개인 도구" data-navigation-group="utilities">
                            <SidebarMenu>
                                {utilityRoutes.map((route) => (
                                    <SidebarNavigationItem
                                        key={route}
                                        route={route}
                                        activeRoute={activeRoute}
                                        navigate={navigate}
                                        unreadCount={unreadCount}
                                    />
                                ))}
                            </SidebarMenu>
                        </nav>
                    ) : null}
                    <SidebarSeparator className="mx-0"/>
                    <div className="flex justify-end group-data-[collapsible=icon]:justify-center">
                        <SidebarCollapseControl/>
                    </div>
                </SidebarFooter>
                <SidebarRail aria-label="사이드바 크기 전환" title="사이드바 크기 전환"/>
            </Sidebar>

            <SidebarInset
                id="dashboard-content"
                tabIndex={-1}
                className="min-w-0 bg-muted/35"
            >
                <ShellTopSpacer
                    personal={personal}
                    activeRoute={activeRoute}
                    navigate={navigate}
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
                navigate={navigate}
            />
        </SidebarProvider>
    );
}
