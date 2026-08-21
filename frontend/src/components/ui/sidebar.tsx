'use client';

import {cva, type VariantProps} from 'class-variance-authority';
import {PanelLeftIcon} from 'lucide-react';
import {Slot} from 'radix-ui';
import * as React from 'react';

import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Separator} from '@/components/ui/separator';
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet';
import {
    sidebarWidthFromKeyboard,
    sidebarWidthFromPointer,
    type SidebarSide,
} from '@/components/ui/sidebar-resize';
import {Skeleton} from '@/components/ui/skeleton';
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from '@/components/ui/tooltip';
import {useIsMobile} from '@/hooks/use-mobile';
import {cn} from '@/lib/utils';

const SIDEBAR_COOKIE_NAME = 'sidebar_state';
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_WIDTH = '16rem';
const SIDEBAR_WIDTH_MOBILE = '18rem';
const SIDEBAR_WIDTH_ICON = '3rem';
const SIDEBAR_KEYBOARD_SHORTCUT = 'b';
const SIDEBAR_RESIZE_MIN_WIDTH = 192;
const SIDEBAR_RESIZE_MAX_WIDTH = 384;
const SIDEBAR_DEFAULT_WIDTH_PX = 256;

function sidebarElements(target: HTMLButtonElement) {
    const sidebar = target.closest<HTMLElement>('[data-slot="sidebar"]');
    return {
        sidebar,
        wrapper: target.closest<HTMLElement>('[data-slot="sidebar-wrapper"]'),
        side: sidebar?.dataset.side === 'right' ? ('right' as const) : ('left' as const),
    };
}

function setSidebarWidth(target: HTMLButtonElement, width: number) {
    sidebarElements(target).wrapper?.style.setProperty('--sidebar-width', `${width}px`);
}

type SidebarContextProps = {
    state: 'expanded' | 'collapsed';
    open: boolean;
    setOpen: (open: boolean) => void;
    openMobile: boolean;
    setOpenMobile: (open: boolean) => void;
    isMobile: boolean;
    toggleSidebar: () => void;
    resizable: boolean;
    resizeMinWidth: number;
    resizeMaxWidth: number;
};

const SidebarContext = React.createContext<SidebarContextProps | null>(null);

function useSidebar() {
    const context = React.useContext(SidebarContext);
    if (!context) {
        throw new Error('useSidebar는 SidebarProvider 안에서 사용해야 합니다.');
    }

    return context;
}

function SidebarProvider({
    defaultOpen = true,
    open: openProp,
    onOpenChange: setOpenProp,
    className,
    style,
    children,
    resizable = false,
    resizeMinWidth = SIDEBAR_RESIZE_MIN_WIDTH,
    resizeMaxWidth = SIDEBAR_RESIZE_MAX_WIDTH,
    ...props
}: React.ComponentProps<'div'> & {
    defaultOpen?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    resizable?: boolean;
    resizeMinWidth?: number;
    resizeMaxWidth?: number;
}) {
    const isMobile = useIsMobile();
    const [openMobile, setOpenMobile] = React.useState(false);

    // This is the internal state of the sidebar.
    // We use openProp and setOpenProp for control from outside the component.
    const [_open, _setOpen] = React.useState(defaultOpen);
    const open = openProp ?? _open;
    const setOpen = React.useCallback(
        (value: boolean | ((value: boolean) => boolean)) => {
            const openState = typeof value === 'function' ? value(open) : value;
            if (setOpenProp) {
                setOpenProp(openState);
            } else {
                _setOpen(openState);
            }

            // This sets the cookie to keep the sidebar state.
            document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
        },
        [setOpenProp, open],
    );

    // Helper to toggle the sidebar.
    const toggleSidebar = React.useCallback(() => {
        return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open);
    }, [isMobile, setOpen, setOpenMobile]);

    // Adds a keyboard shortcut to toggle the sidebar.
    React.useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                toggleSidebar();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [toggleSidebar]);

    // We add a state so that we can do data-state="expanded" or "collapsed".
    // This makes it easier to style the sidebar with Tailwind classes.
    const state = open ? 'expanded' : 'collapsed';
    const normalizedResizeMinWidth = Math.max(0, resizeMinWidth);
    const normalizedResizeMaxWidth = Math.max(normalizedResizeMinWidth, resizeMaxWidth);

    const contextValue = React.useMemo<SidebarContextProps>(
        () => ({
            state,
            open,
            setOpen,
            isMobile,
            openMobile,
            setOpenMobile,
            toggleSidebar,
            resizable,
            resizeMinWidth: normalizedResizeMinWidth,
            resizeMaxWidth: normalizedResizeMaxWidth,
        }),
        [
            state,
            open,
            setOpen,
            isMobile,
            openMobile,
            setOpenMobile,
            toggleSidebar,
            resizable,
            normalizedResizeMinWidth,
            normalizedResizeMaxWidth,
        ],
    );

    return (
        <SidebarContext.Provider value={contextValue}>
            <TooltipProvider delayDuration={0}>
                <div
                    data-slot="sidebar-wrapper"
                    data-sidebar-resizable={resizable ? 'true' : undefined}
                    style={
                        {
                            '--sidebar-width': SIDEBAR_WIDTH,
                            '--sidebar-width-icon': SIDEBAR_WIDTH_ICON,
                            ...style,
                        } as React.CSSProperties
                    }
                    className={cn(
                        'group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar',
                        className,
                    )}
                    {...props}
                >
                    {children}
                </div>
            </TooltipProvider>
        </SidebarContext.Provider>
    );
}

function Sidebar({
    side = 'left',
    variant = 'sidebar',
    collapsible = 'offcanvas',
    className,
    children,
    ...props
}: React.ComponentProps<'div'> & {
    side?: 'left' | 'right';
    variant?: 'sidebar' | 'floating' | 'inset';
    collapsible?: 'offcanvas' | 'icon' | 'none';
}) {
    const {isMobile, state, openMobile, setOpenMobile} = useSidebar();

    if (collapsible === 'none') {
        return (
            <div
                data-slot="sidebar"
                className={cn(
                    'flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground',
                    className,
                )}
                {...props}
            >
                {children}
            </div>
        );
    }

    if (isMobile) {
        return (
            <Sheet open={openMobile} onOpenChange={setOpenMobile} {...props}>
                <SheetContent
                    data-sidebar="sidebar"
                    data-slot="sidebar"
                    data-mobile="true"
                    className="w-(--sidebar-width) bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden"
                    style={
                        {
                            '--sidebar-width': SIDEBAR_WIDTH_MOBILE,
                        } as React.CSSProperties
                    }
                    side={side}
                >
                    <SheetHeader className="sr-only">
                        <SheetTitle>사이드바</SheetTitle>
                        <SheetDescription>모바일 사이드바를 표시합니다.</SheetDescription>
                    </SheetHeader>
                    <div className="flex h-full w-full flex-col">{children}</div>
                </SheetContent>
            </Sheet>
        );
    }

    return (
        <div
            className="group peer hidden text-sidebar-foreground md:block"
            data-state={state}
            data-collapsible={state === 'collapsed' ? collapsible : ''}
            data-variant={variant}
            data-side={side}
            data-slot="sidebar"
        >
            {/* This is what handles the sidebar gap on desktop */}
            <div
                data-slot="sidebar-gap"
                className={cn(
                    'relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear group-data-[sidebar-resizing=true]/sidebar-wrapper:transition-none',
                    'group-data-[collapsible=offcanvas]:w-0',
                    'group-data-[side=right]:rotate-180',
                    variant === 'floating' || variant === 'inset'
                        ? 'group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]'
                        : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon)',
                )}
            />
            <div
                data-slot="sidebar-container"
                className={cn(
                    'fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear group-data-[sidebar-resizing=true]/sidebar-wrapper:transition-none md:flex',
                    side === 'left'
                        ? 'left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]'
                        : 'right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]',
                    // Adjust the padding for floating and inset variants.
                    variant === 'floating' || variant === 'inset'
                        ? 'p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]'
                        : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l',
                    className,
                )}
                {...props}
            >
                <div
                    data-sidebar="sidebar"
                    data-slot="sidebar-inner"
                    className="flex h-full w-full flex-col bg-sidebar group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow-sm"
                >
                    {children}
                </div>
            </div>
        </div>
    );
}

function SidebarTrigger({className, onClick, ...props}: React.ComponentProps<typeof Button>) {
    const {toggleSidebar} = useSidebar();

    return (
        <Button
            data-sidebar="trigger"
            data-slot="sidebar-trigger"
            variant="ghost"
            size="icon"
            className={cn('size-7', className)}
            onClick={(event) => {
                onClick?.(event);
                toggleSidebar();
            }}
            {...props}
        >
            <PanelLeftIcon />
            <span className="sr-only">사이드바 전환</span>
        </Button>
    );
}

function SidebarRail({
    className,
    onClick,
    onKeyDown,
    onPointerCancel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    ...props
}: React.ComponentProps<'button'>) {
    const {toggleSidebar, resizable, resizeMinWidth, resizeMaxWidth, state} = useSidebar();
    const activePointerId = React.useRef<number | null>(null);
    const dragStartX = React.useRef(0);
    const dragEndedAt = React.useRef(0);
    const dragged = React.useRef(false);
    const suppressNextClick = React.useRef(false);
    const wrapper = React.useRef<HTMLElement | null>(null);
    const sidebarSide = React.useRef<SidebarSide>('left');
    const removeWindowListeners = React.useRef<(() => void) | null>(null);
    const previousBodyCursor = React.useRef('');
    const previousBodyUserSelect = React.useRef('');

    const restoreDocumentInteraction = React.useCallback(() => {
        removeWindowListeners.current?.();
        removeWindowListeners.current = null;
        wrapper.current?.removeAttribute('data-sidebar-resizing');
        wrapper.current = null;
        if (typeof document !== 'undefined') {
            document.body.style.cursor = previousBodyCursor.current;
            document.body.style.userSelect = previousBodyUserSelect.current;
        }
    }, []);

    React.useEffect(() => restoreDocumentInteraction, [restoreDocumentInteraction]);

    const finishResize = (target: HTMLButtonElement, pointerId: number) => {
        if (activePointerId.current !== pointerId) return;
        try {
            if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
        } catch {
            // Window-level listeners keep resize working when pointer capture is unavailable.
        }
        suppressNextClick.current = dragged.current;
        dragEndedAt.current = Date.now();
        activePointerId.current = null;
        restoreDocumentInteraction();
    };

    return (
        <button
            data-sidebar="rail"
            data-slot="sidebar-rail"
            data-resizable={resizable ? 'true' : undefined}
            aria-label={resizable ? '사이드바 크기 조절' : '사이드바 전환'}
            tabIndex={resizable ? 0 : -1}
            onClick={(event) => {
                onClick?.(event);
                if (event.defaultPrevented) return;
                const shouldSuppressClick =
                    suppressNextClick.current && Date.now() - dragEndedAt.current < 100;
                suppressNextClick.current = false;
                if (shouldSuppressClick) {
                    event.preventDefault();
                    return;
                }
                toggleSidebar();
            }}
            onKeyDown={(event) => {
                onKeyDown?.(event);
                if (
                    event.defaultPrevented ||
                    !resizable ||
                    state !== 'expanded' ||
                    !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
                )
                    return;

                event.preventDefault();
                const elements = sidebarElements(event.currentTarget);
                const configuredWidth =
                    elements.wrapper?.style.getPropertyValue('--sidebar-width').trim() ?? '';
                const configuredPixelWidth = configuredWidth.endsWith('px')
                    ? Number.parseFloat(configuredWidth)
                    : Number.NaN;
                const renderedWidth =
                    elements.sidebar
                        ?.querySelector<HTMLElement>('[data-slot="sidebar-container"]')
                        ?.getBoundingClientRect().width ?? SIDEBAR_DEFAULT_WIDTH_PX;
                const currentWidth = Number.isFinite(configuredPixelWidth)
                    ? configuredPixelWidth
                    : renderedWidth;
                setSidebarWidth(
                    event.currentTarget,
                    sidebarWidthFromKeyboard(
                        currentWidth || SIDEBAR_DEFAULT_WIDTH_PX,
                        event.key,
                        elements.side,
                        resizeMinWidth,
                        resizeMaxWidth,
                    ),
                );
            }}
            onPointerDown={(event) => {
                onPointerDown?.(event);
                if (
                    event.defaultPrevented ||
                    !resizable ||
                    state !== 'expanded' ||
                    event.button !== 0 ||
                    !event.isPrimary
                )
                    return;

                const elements = sidebarElements(event.currentTarget);
                if (!elements.wrapper) return;
                if (activePointerId.current !== null) {
                    activePointerId.current = null;
                    restoreDocumentInteraction();
                }
                activePointerId.current = event.pointerId;
                dragStartX.current = event.clientX;
                dragged.current = false;
                wrapper.current = elements.wrapper;
                sidebarSide.current = elements.side;
                elements.wrapper.dataset.sidebarResizing = 'true';
                previousBodyCursor.current = document.body.style.cursor;
                previousBodyUserSelect.current = document.body.style.userSelect;
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                const pointerId = event.pointerId;
                const target = event.currentTarget;
                const handlePointerMove = (pointerEvent: PointerEvent) => {
                    if (
                        pointerEvent.defaultPrevented ||
                        activePointerId.current !== pointerEvent.pointerId
                    )
                        return;
                    if (Math.abs(pointerEvent.clientX - dragStartX.current) < 3 && !dragged.current)
                        return;

                    dragged.current = true;
                    elements.wrapper?.style.setProperty(
                        '--sidebar-width',
                        `${sidebarWidthFromPointer({
                            clientX: pointerEvent.clientX,
                            viewportWidth: window.innerWidth,
                            side: sidebarSide.current,
                            minWidth: resizeMinWidth,
                            maxWidth: resizeMaxWidth,
                        })}px`,
                    );
                };
                const handlePointerEnd = (pointerEvent: PointerEvent) => {
                    finishResize(target, pointerEvent.pointerId);
                };
                window.addEventListener('pointermove', handlePointerMove);
                window.addEventListener('pointerup', handlePointerEnd);
                window.addEventListener('pointercancel', handlePointerEnd);
                removeWindowListeners.current = () => {
                    window.removeEventListener('pointermove', handlePointerMove);
                    window.removeEventListener('pointerup', handlePointerEnd);
                    window.removeEventListener('pointercancel', handlePointerEnd);
                };
                try {
                    target.setPointerCapture(pointerId);
                } catch {
                    // The window-level listeners above are the compatibility fallback.
                }
            }}
            onPointerMove={(event) => {
                onPointerMove?.(event);
            }}
            onPointerUp={(event) => {
                onPointerUp?.(event);
                finishResize(event.currentTarget, event.pointerId);
            }}
            onPointerCancel={(event) => {
                onPointerCancel?.(event);
                dragged.current = false;
                finishResize(event.currentTarget, event.pointerId);
            }}
            title={resizable ? '드래그해 크기 조절 · 클릭해 전환' : '사이드바 전환'}
            className={cn(
                'absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 transition-all ease-linear group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border sm:flex',
                resizable
                    ? 'cursor-col-resize touch-none'
                    : 'in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize',
                '[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize',
                'group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full hover:group-data-[collapsible=offcanvas]:bg-sidebar',
                '[[data-side=left][data-collapsible=offcanvas]_&]:-right-2',
                '[[data-side=right][data-collapsible=offcanvas]_&]:-left-2',
                className,
            )}
            {...props}
        />
    );
}

function SidebarInset({className, ...props}: React.ComponentProps<'main'>) {
    return (
        <main
            data-slot="sidebar-inset"
            className={cn(
                'relative flex w-full flex-1 flex-col bg-background',
                'md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2',
                className,
            )}
            {...props}
        />
    );
}

function SidebarInput({className, ...props}: React.ComponentProps<typeof Input>) {
    return (
        <Input
            data-slot="sidebar-input"
            data-sidebar="input"
            className={cn('h-8 w-full bg-background shadow-none', className)}
            {...props}
        />
    );
}

function SidebarHeader({className, ...props}: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="sidebar-header"
            data-sidebar="header"
            className={cn('flex flex-col gap-2 p-2', className)}
            {...props}
        />
    );
}

function SidebarFooter({className, ...props}: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="sidebar-footer"
            data-sidebar="footer"
            className={cn('flex flex-col gap-2 p-2', className)}
            {...props}
        />
    );
}

function SidebarSeparator({className, ...props}: React.ComponentProps<typeof Separator>) {
    return (
        <Separator
            data-slot="sidebar-separator"
            data-sidebar="separator"
            className={cn('mx-2 w-auto bg-sidebar-border', className)}
            {...props}
        />
    );
}

function SidebarContent({className, ...props}: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="sidebar-content"
            data-sidebar="content"
            className={cn(
                'flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden',
                className,
            )}
            {...props}
        />
    );
}

function SidebarGroup({className, ...props}: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="sidebar-group"
            data-sidebar="group"
            className={cn('relative flex w-full min-w-0 flex-col p-2', className)}
            {...props}
        />
    );
}

function SidebarGroupLabel({
    className,
    asChild = false,
    ...props
}: React.ComponentProps<'div'> & {asChild?: boolean}) {
    const Comp = asChild ? Slot.Root : 'div';

    return (
        <Comp
            data-slot="sidebar-group-label"
            data-sidebar="group-label"
            className={cn(
                'flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 ring-sidebar-ring outline-hidden transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
                'group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0',
                className,
            )}
            {...props}
        />
    );
}

function SidebarGroupAction({
    className,
    asChild = false,
    ...props
}: React.ComponentProps<'button'> & {asChild?: boolean}) {
    const Comp = asChild ? Slot.Root : 'button';

    return (
        <Comp
            data-slot="sidebar-group-action"
            data-sidebar="group-action"
            className={cn(
                'absolute top-3.5 right-3 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground ring-sidebar-ring outline-hidden transition-transform hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
                // Increases the hit area of the button on mobile.
                'after:absolute after:-inset-2 md:after:hidden',
                'group-data-[collapsible=icon]:hidden',
                className,
            )}
            {...props}
        />
    );
}

function SidebarGroupContent({className, ...props}: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="sidebar-group-content"
            data-sidebar="group-content"
            className={cn('w-full text-sm', className)}
            {...props}
        />
    );
}

function SidebarMenu({className, ...props}: React.ComponentProps<'ul'>) {
    return (
        <ul
            data-slot="sidebar-menu"
            data-sidebar="menu"
            className={cn('flex w-full min-w-0 flex-col gap-1', className)}
            {...props}
        />
    );
}

function SidebarMenuItem({className, ...props}: React.ComponentProps<'li'>) {
    return (
        <li
            data-slot="sidebar-menu-item"
            data-sidebar="menu-item"
            className={cn('group/menu-item relative', className)}
            {...props}
        />
    );
}

const sidebarMenuButtonVariants = cva(
    'peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm ring-sidebar-ring outline-hidden transition-[width,height,padding] group-has-data-[sidebar=menu-action]/menu-item:pr-8 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0',
    {
        variants: {
            variant: {
                default: 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                outline:
                    'bg-background shadow-[0_0_0_1px_var(--sidebar-border)] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_var(--sidebar-accent)]',
            },
            size: {
                default: 'h-8 text-sm',
                sm: 'h-7 text-xs',
                lg: 'h-12 text-sm group-data-[collapsible=icon]:p-0!',
            },
        },
        defaultVariants: {
            variant: 'default',
            size: 'default',
        },
    },
);

function SidebarMenuButton({
    asChild = false,
    isActive = false,
    variant = 'default',
    size = 'default',
    tooltip,
    className,
    ...props
}: React.ComponentProps<'button'> & {
    asChild?: boolean;
    isActive?: boolean;
    tooltip?: string | React.ComponentProps<typeof TooltipContent>;
} & VariantProps<typeof sidebarMenuButtonVariants>) {
    const Comp = asChild ? Slot.Root : 'button';
    const {isMobile, state} = useSidebar();

    const button = (
        <Comp
            data-slot="sidebar-menu-button"
            data-sidebar="menu-button"
            data-size={size}
            data-active={isActive}
            className={cn(sidebarMenuButtonVariants({variant, size}), className)}
            {...props}
        />
    );

    if (!tooltip) {
        return button;
    }

    if (typeof tooltip === 'string') {
        tooltip = {
            children: tooltip,
        };
    }

    return (
        <Tooltip>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent
                side="right"
                align="center"
                hidden={state !== 'collapsed' || isMobile}
                {...tooltip}
            />
        </Tooltip>
    );
}

function SidebarMenuAction({
    className,
    asChild = false,
    showOnHover = false,
    ...props
}: React.ComponentProps<'button'> & {
    asChild?: boolean;
    showOnHover?: boolean;
}) {
    const Comp = asChild ? Slot.Root : 'button';

    return (
        <Comp
            data-slot="sidebar-menu-action"
            data-sidebar="menu-action"
            className={cn(
                'absolute top-1.5 right-1 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground ring-sidebar-ring outline-hidden transition-transform peer-hover/menu-button:text-sidebar-accent-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
                // Increases the hit area of the button on mobile.
                'after:absolute after:-inset-2 md:after:hidden',
                'peer-data-[size=sm]/menu-button:top-1',
                'peer-data-[size=default]/menu-button:top-1.5',
                'peer-data-[size=lg]/menu-button:top-2.5',
                'group-data-[collapsible=icon]:hidden',
                showOnHover &&
                    'group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 peer-data-[active=true]/menu-button:text-sidebar-accent-foreground data-[state=open]:opacity-100 md:opacity-0',
                className,
            )}
            {...props}
        />
    );
}

function SidebarMenuBadge({className, ...props}: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="sidebar-menu-badge"
            data-sidebar="menu-badge"
            className={cn(
                'pointer-events-none absolute right-1 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-medium text-sidebar-foreground tabular-nums select-none',
                'peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[active=true]/menu-button:text-sidebar-accent-foreground',
                'peer-data-[size=sm]/menu-button:top-1',
                'peer-data-[size=default]/menu-button:top-1.5',
                'peer-data-[size=lg]/menu-button:top-2.5',
                'group-data-[collapsible=icon]:hidden',
                className,
            )}
            {...props}
        />
    );
}

function SidebarMenuSkeleton({
    className,
    showIcon = false,
    ...props
}: React.ComponentProps<'div'> & {
    showIcon?: boolean;
}) {
    // Random width between 50 to 90%.
    const width = React.useMemo(() => {
        return `${Math.floor(Math.random() * 40) + 50}%`;
    }, []);

    return (
        <div
            data-slot="sidebar-menu-skeleton"
            data-sidebar="menu-skeleton"
            className={cn('flex h-8 items-center gap-2 rounded-md px-2', className)}
            {...props}
        >
            {showIcon && (
                <Skeleton className="size-4 rounded-md" data-sidebar="menu-skeleton-icon" />
            )}
            <Skeleton
                className="h-4 max-w-(--skeleton-width) flex-1"
                data-sidebar="menu-skeleton-text"
                style={
                    {
                        '--skeleton-width': width,
                    } as React.CSSProperties
                }
            />
        </div>
    );
}

function SidebarMenuSub({className, ...props}: React.ComponentProps<'ul'>) {
    return (
        <ul
            data-slot="sidebar-menu-sub"
            data-sidebar="menu-sub"
            className={cn(
                'mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l border-sidebar-border px-2.5 py-0.5',
                'group-data-[collapsible=icon]:hidden',
                className,
            )}
            {...props}
        />
    );
}

function SidebarMenuSubItem({className, ...props}: React.ComponentProps<'li'>) {
    return (
        <li
            data-slot="sidebar-menu-sub-item"
            data-sidebar="menu-sub-item"
            className={cn('group/menu-sub-item relative', className)}
            {...props}
        />
    );
}

function SidebarMenuSubButton({
    asChild = false,
    size = 'md',
    isActive = false,
    className,
    ...props
}: React.ComponentProps<'a'> & {
    asChild?: boolean;
    size?: 'sm' | 'md';
    isActive?: boolean;
}) {
    const Comp = asChild ? Slot.Root : 'a';

    return (
        <Comp
            data-slot="sidebar-menu-sub-button"
            data-sidebar="menu-sub-button"
            data-size={size}
            data-active={isActive}
            className={cn(
                'flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 text-sidebar-foreground ring-sidebar-ring outline-hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-accent-foreground',
                'data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground',
                size === 'sm' && 'text-xs',
                size === 'md' && 'text-sm',
                'group-data-[collapsible=icon]:hidden',
                className,
            )}
            {...props}
        />
    );
}

export {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupAction,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarInput,
    SidebarInset,
    SidebarMenu,
    SidebarMenuAction,
    SidebarMenuBadge,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarMenuSkeleton,
    SidebarMenuSub,
    SidebarMenuSubButton,
    SidebarMenuSubItem,
    SidebarProvider,
    SidebarRail,
    SidebarSeparator,
    SidebarTrigger,
    useSidebar,
};
