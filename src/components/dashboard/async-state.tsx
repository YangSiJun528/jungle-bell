import {AlertCircle, Inbox, LoaderCircle} from 'lucide-react';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';

export function LoadingState({label = '정보를 불러오고 있습니다.'}: {label?: string}) {
    return (
        <div className="flex min-h-32 items-center justify-center gap-2 rounded-lg bg-muted/60 p-6 text-sm text-muted-foreground">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin"/>
            {label}
        </div>
    );
}

export function ErrorState({title = '정보를 불러오지 못했습니다.', description, retry}: {
    title?: string;
    description?: string;
    retry?: () => void;
}) {
    return (
        <Alert variant="destructive">
            <AlertCircle aria-hidden="true"/>
            <AlertTitle>{title}</AlertTitle>
            {description || retry ? (
                <AlertDescription>
                    {description ? <p>{description}</p> : null}
                    {retry ? <Button className="mt-2" size="sm" variant="outline" onClick={retry}>다시 시도</Button> : null}
                </AlertDescription>
            ) : null}
        </Alert>
    );
}

export function EmptyState({title, description}: {title: string; description?: string}) {
    return (
        <div className="flex min-h-32 flex-col items-center justify-center rounded-lg border border-dashed bg-muted/30 p-6 text-center">
            <Inbox aria-hidden="true" className="mb-2 size-5 text-muted-foreground"/>
            <strong className="text-sm">{title}</strong>
            {description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p> : null}
        </div>
    );
}
