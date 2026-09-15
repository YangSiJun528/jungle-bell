import {Expand, X} from 'lucide-react';
import {Dialog} from 'radix-ui';
import {useRef, useState} from 'react';

import {Button} from '@/components/ui/button';

export interface InstallGuideScreenshot {
    id: string;
    title: string;
    description: string;
    src: string;
    width: number;
    height: number;
}

export function InstallScreenshotGuide({
    screenshots,
    label,
}: {
    screenshots: readonly InstallGuideScreenshot[];
    label: string;
}) {
    const [selectedScreenshot, setSelectedScreenshot] = useState<InstallGuideScreenshot | null>(
        null,
    );
    const selectedTrigger = useRef<HTMLButtonElement | null>(null);
    const singleScreenshot = screenshots.length === 1;

    return (
        <>
            <ol
                aria-label={label}
                className={
                    singleScreenshot
                        ? 'grid max-w-2xl min-w-0 gap-4'
                        : 'flex min-w-0 snap-x snap-mandatory gap-4 overflow-x-auto pb-3'
                }
            >
                {screenshots.map((screenshot, index) => (
                    <li
                        key={screenshot.id}
                        className={
                            singleScreenshot ? 'min-w-0' : 'w-48 min-w-0 shrink-0 snap-start'
                        }
                    >
                        <Button
                            type="button"
                            variant="outline"
                            className="group relative block h-auto w-full overflow-hidden rounded-xl bg-muted/30 p-2"
                            aria-label={`${screenshot.title} 화면 크게 보기`}
                            onClick={(event) => {
                                selectedTrigger.current = event.currentTarget;
                                setSelectedScreenshot(screenshot);
                            }}
                        >
                            <img
                                src={screenshot.src}
                                alt={screenshot.title}
                                width={screenshot.width}
                                height={screenshot.height}
                                loading="lazy"
                                decoding="async"
                                className="mx-auto h-65 w-full object-contain"
                            />
                            <span className="absolute right-2 bottom-2 rounded-md border bg-background/95 p-1.5 text-muted-foreground group-hover:text-foreground">
                                <Expand aria-hidden="true" className="size-4" />
                            </span>
                        </Button>
                        <h4 className="mt-3 text-base leading-6 font-semibold">
                            {singleScreenshot ? null : `${index + 1}. `}
                            {screenshot.title}
                        </h4>
                        <p className="mt-1 text-sm leading-6 text-muted-foreground">
                            {screenshot.description}
                        </p>
                    </li>
                ))}
            </ol>

            <Dialog.Root
                open={selectedScreenshot !== null}
                onOpenChange={(open) => {
                    if (!open) setSelectedScreenshot(null);
                }}
            >
                <Dialog.Portal>
                    <Dialog.Overlay className="fixed inset-0 z-50 bg-black/65" />
                    <Dialog.Content
                        className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto rounded-xl border bg-background p-4 shadow-lg sm:p-6"
                        onCloseAutoFocus={(event) => {
                            event.preventDefault();
                            selectedTrigger.current?.focus();
                        }}
                    >
                        <div className="sticky top-0 z-10 flex shrink-0 items-start justify-between gap-3 bg-background pb-2">
                            <div className="min-w-0">
                                <Dialog.Title className="text-lg leading-7 font-semibold">
                                    {selectedScreenshot?.title}
                                </Dialog.Title>
                                <Dialog.Description className="mt-1 text-sm leading-6 text-muted-foreground">
                                    {selectedScreenshot?.description}
                                </Dialog.Description>
                            </div>
                            <Dialog.Close asChild>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="shrink-0"
                                    aria-label="확대 화면 닫기"
                                >
                                    <X aria-hidden="true" />
                                </Button>
                            </Dialog.Close>
                        </div>
                        {selectedScreenshot ? (
                            <img
                                src={selectedScreenshot.src}
                                alt={selectedScreenshot.title}
                                width={selectedScreenshot.width}
                                height={selectedScreenshot.height}
                                decoding="async"
                                className="mx-auto mt-4 h-auto w-full max-w-2xl shrink-0 object-contain"
                            />
                        ) : null}
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        </>
    );
}
