import type {PersonalSurface} from '@/api/personal-api';
import {AttendancePreferencesSection} from '@/features/attendance/attendance-preferences-section';
import {MealPreferencesSection} from '@/features/meals/components/meal-preferences-section';

export function NotificationSettings({surface}: {surface: PersonalSurface}) {
    return (
        <div className="space-y-6">
            <AttendancePreferencesSection surface={surface}/>
            <MealPreferencesSection surface={surface}/>
        </div>
    );
}
