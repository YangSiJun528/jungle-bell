import jungleBellLogo from '@/assets/logo.png';
import {cn} from '@/lib/utils';

const NOTIFICATIONS = [
    {
        time: '지금',
        title: '학습 종료 가능 시간이에요.',
        description: '정글캠퍼스로 바로가기.',
    },
    {
        time: '1분 전',
        title: '남성 3번 세탁이 곧 끝나요',
        description: '예상 종료까지 4분 남았어요.',
    },
    {
        time: '12분 전',
        title: '오늘 저녁 메뉴가 게시됐어요',
        description: '닭갈비 · 계란찜',
    },
] as const;

export function MobileNotificationMockup({
    className,
    phone = false,
}: {
    className?: string;
    phone?: boolean;
}) {
    return (
        <figure
            className={cn(
                'relative isolate min-h-[24rem] overflow-hidden border border-white/45',
                'bg-[#6f9875]',
                'shadow-[0_24px_56px_rgba(24,49,29,.3)]',
                phone
                    ? 'min-h-[22rem] rounded-[2rem] border-[0.375rem] border-[#272d28]'
                    : 'rounded-2xl',
                className,
            )}
        >
            <figcaption className="sr-only">
                모바일 잠금 화면에 표시된 Jungle Bell 출석, 세탁, 식사 알림 예시
            </figcaption>
            <span
                className="absolute top-2 left-1/2 h-4 w-16 -translate-x-1/2 rounded-full bg-[#252b26]"
                aria-hidden="true"
            />
            <div className="grid justify-items-center pt-10 text-white [text-shadow:0_2px_8px_rgba(26,55,32,.25)]">
                <small className="text-[0.625rem]">8월 18일 화요일</small>
                <time className="text-5xl font-light tracking-[-0.06em]" dateTime="17:28">
                    5:28
                </time>
            </div>
            <div className={cn('grid gap-2 px-3 pt-8 pb-3', phone && 'pt-10')}>
                {NOTIFICATIONS.map((notification) => (
                    <article
                        className="rounded-xl border border-white/60 bg-white/88 p-2.5 text-[#303a32] shadow-lg backdrop-blur-xl"
                        key={notification.title}
                    >
                        <header className="grid grid-cols-[auto_1fr_auto] items-center gap-1.5">
                            <img
                                src={jungleBellLogo}
                                alt=""
                                className="size-5 rounded-md"
                                aria-hidden="true"
                            />
                            <strong className="text-[0.625rem]">Jungle Bell</strong>
                            <small className="text-[0.5625rem] text-[#738076]">
                                {notification.time}
                            </small>
                        </header>
                        <p className="mt-1.5 grid gap-0.5 text-[0.5625rem] leading-snug text-[#68736b]">
                            <strong className="text-[0.6875rem] text-[#303a32]">
                                {notification.title}
                            </strong>
                            {notification.description}
                        </p>
                    </article>
                ))}
            </div>
        </figure>
    );
}
