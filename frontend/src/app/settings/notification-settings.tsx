import {AttendancePreferencesSection} from '@/features/attendance/attendance-preferences-section';
import {MealPreferencesSection} from '@/features/meals/components/meal-preferences-section';

export function NotificationSettings() {
    return (
        <div className="space-y-6">
            <AttendancePreferencesSection/>
            <MealPreferencesSection/>
        </div>
    );
}
