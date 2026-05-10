const MAX_GOAL_OBJECTIVE_CHARS = 4000;
export function normalizeAndValidateObjective(raw: string): {
    objective: string;
    error: string | null;
} {
    const objective = raw.trim();
    if (!objective) {
        return { objective: "", error: "goal objective must not be empty" };
    }
    const charCount = [...objective].length;
    if (charCount > MAX_GOAL_OBJECTIVE_CHARS) {
        return {
            objective: "",
            error: `goal objective must be at most ${MAX_GOAL_OBJECTIVE_CHARS} characters`,
        };
    }
    return { objective, error: null };
}
export function validateGoalBudget(value: unknown): {
    value: number | undefined;
    error: string | null;
} {
    if (value === undefined || value === null) {
        return { value: undefined, error: null };
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return { value: undefined, error: "goal budgets must be positive integers when provided" };
    }
    if (!Number.isInteger(value) || value <= 0) {
        return { value: undefined, error: "goal budgets must be positive integers when provided" };
    }
    return { value, error: null };
}
