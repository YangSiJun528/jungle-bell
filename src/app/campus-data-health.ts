export type CampusDataKind = 'laundry' | 'meals';

export interface CampusDataIssue {
    message: string;
    reportedAt: number;
}

export interface CampusDataHealth {
    laundry: CampusDataIssue | null;
    meals: CampusDataIssue | null;
}

export type CampusDataHealthAction =
    | {
        type: 'failed';
        kind: CampusDataKind;
        message: string;
        reportedAt: number;
    }
    | {
        type: 'succeeded';
        kind: CampusDataKind;
    };

export const initialCampusDataHealth: CampusDataHealth = {
    laundry: null,
    meals: null,
};

export function campusDataHealthReducer(
    state: CampusDataHealth,
    action: CampusDataHealthAction,
): CampusDataHealth {
    if (action.type === 'succeeded') {
        if (state[action.kind] === null) return state;
        return {...state, [action.kind]: null};
    }
    return {
        ...state,
        [action.kind]: {
            message: action.message,
            reportedAt: action.reportedAt,
        },
    };
}
