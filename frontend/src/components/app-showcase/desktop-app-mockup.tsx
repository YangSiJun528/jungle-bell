import {Apple} from 'lucide-react';
import {cn} from '@/lib/utils';
import {TrayIcon, type TrayIconStatus} from './tray-icon';

const TRAY_STATES: readonly {
    status: TrayIconStatus;
    label: string;
    description: string;
}[] = [
    {status: 'alert', label: '출석 필요', description: '빨강'},
    {status: 'warning', label: '로그인 필요', description: '주황'},
    {status: 'normal', label: '학습 중', description: '기본색'},
    {status: 'offline', label: '확인 불가', description: '회색'},
];

export function DesktopAppMockup({
    className,
    compact = false,
}: {
    className?: string;
    compact?: boolean;
}) {
    return (
        <figure
            className={cn(
                'relative isolate min-h-[20rem] overflow-hidden rounded-2xl border border-white/45',
                'bg-[#7653a7]',
                'shadow-[0_24px_56px_rgba(25,53,31,.24)]',
                compact ? 'min-h-[17rem]' : 'min-h-[24rem]',
                className,
            )}
        >
            <figcaption className="sr-only">
                macOS 메뉴 막대에서 Jungle Bell 출석 상태를 확인하는 PC 앱 예시
            </figcaption>

            <div className="relative z-20 flex h-9 items-center justify-between border-b border-white/45 bg-white/85 px-3 text-[0.625rem] font-semibold text-[#202720] backdrop-blur-xl">
                <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
                    <Apple aria-hidden="true" className="size-3 fill-current"/>
                    <strong>Finder</strong>
                    <span className="hidden sm:inline">파일&nbsp;&nbsp;편집&nbsp;&nbsp;보기</span>
                </span>
                <span className="flex items-center gap-2 whitespace-nowrap">
                    <span className="relative grid size-7 place-items-center rounded-lg ring-2 ring-[#e23c44] ring-offset-2 ring-offset-white/80 shadow-[0_0_18px_rgba(180,35,44,.55)]">
                        <TrayIcon
                            status="alert"
                            label="출석 필요 상태의 Jungle Bell 트레이 아이콘"
                            className="size-6"
                        />
                        <span className="absolute left-1/2 top-[2.05rem] h-7 w-0.5 -translate-x-1/2 bg-[#e23c44]" aria-hidden="true"/>
                    </span>
                    <span aria-hidden="true">⌁ &nbsp;▮▮</span>
                    <time dateTime="17:28">17:28</time>
                </span>
            </div>

            <div className={cn(
                'absolute right-4 top-20 z-10 grid w-[min(13rem,52%)] gap-1 rounded-xl border border-white/70 bg-white/88 p-3 text-[#263128] shadow-xl backdrop-blur-xl',
                compact && 'left-[38%] right-auto top-16 w-[42%]',
            )}>
                <small className="font-bold text-[#a42a31]">Jungle Bell 트레이</small>
                <strong className="text-xs leading-snug sm:text-sm">빨간색이면 출석을 확인할 시간이에요.</strong>
            </div>

            <div className={cn(
                'absolute left-5 top-36 z-10 rounded-xl border border-white/45 bg-white/15 p-4 text-white shadow-sm backdrop-blur-sm',
                compact && 'top-20 w-[31%] p-3',
            )}>
                <small className="block font-semibold">PC 앱</small>
                <strong className="mt-1 block text-base leading-snug sm:text-lg">메뉴 바에서<br/>출석 상태를 확인</strong>
            </div>

            <div
                className={cn(
                    'absolute inset-x-3 bottom-12 z-10 grid grid-cols-4 gap-1.5 rounded-xl border border-white/60 bg-white/75 p-2 backdrop-blur-xl',
                    compact && 'grid-cols-3',
                )}
                aria-label="Jungle Bell 트레이 상태 예시"
            >
                {TRAY_STATES.slice(0, compact ? 3 : 4).map((state) => (
                    <span className="grid min-w-0 justify-items-center gap-0.5 rounded-lg bg-white/65 px-1 py-2 text-center" key={state.status}>
                        <TrayIcon
                            status={state.status}
                            label={`${state.label} 트레이 아이콘`}
                            className="size-7 sm:size-8"
                        />
                        <strong className="truncate text-[0.5rem] sm:text-[0.625rem]">{state.label}</strong>
                        {compact ? null : <small className="text-[0.5rem] text-muted-foreground">{state.description}</small>}
                    </span>
                ))}
            </div>

            <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 gap-1 rounded-xl border border-white/40 bg-white/40 p-1.5 shadow-lg backdrop-blur-xl" aria-hidden="true">
                {['bg-blue-500', 'bg-emerald-500', 'bg-amber-400', 'bg-rose-400', 'bg-violet-500'].map((color) => (
                    <span className={cn('size-4 rounded-[0.3rem]', color)} key={color}/>
                ))}
            </div>
        </figure>
    );
}
