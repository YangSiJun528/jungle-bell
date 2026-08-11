import {LoaderCircle} from 'lucide-react';
import {Button} from '@/components/ui/button';

export function MealHistoryLoadMore({
    loading,
    onLoad,
}: {
    loading: boolean;
    onLoad: () => void;
}) {
    return (
        <Button disabled={loading} variant="outline" onClick={onLoad}>
            {loading ? <LoaderCircle className="animate-spin"/> : null}
            {loading ? '이전 기록 불러오는 중' : '이전 기록 더 불러오기'}
        </Button>
    );
}
