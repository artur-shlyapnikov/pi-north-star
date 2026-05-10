export type ParsedGoalCommand = {
    kind: "show";
} | {
    kind: "create";
    objective: string;
    budget?: number;
} | {
    kind: "pause";
} | {
    kind: "resume";
    budget?: number;
} | {
    kind: "clear";
} | {
    kind: "replace";
    objective: string;
    budget?: number;
} | {
    kind: "budget";
    budget?: number;
} | {
    kind: "verify-show";
} | {
    kind: "verify-set";
    policyRaw: string;
} | {
    kind: "plan-file-show";
} | {
    kind: "plan-file-set";
    enabled: boolean;
} | {
    kind: "syntax-error";
    usage: string;
};
export function parseGoalCommand(args: string | undefined): ParsedGoalCommand {
    const trimmed = (args ?? "").trim();
    if (!trimmed) {
        return { kind: "show" };
    }
    const tokens = trimmed.split(/\s+/);
    const first = tokens[0].toLowerCase();
    if (first === "pause") {
        return { kind: "pause" };
    }
    if (first === "clear") {
        return { kind: "clear" };
    }
    if (first === "resume") {
        const rest = tokens.slice(1).join(" ").trim();
        if (!rest) {
            return { kind: "resume", budget: undefined };
        }
        const budgetMatch = rest.match(/^--budget\s+(\d+)$/);
        if (budgetMatch) {
            return { kind: "resume", budget: parseInt(budgetMatch[1], 10) };
        }
        return { kind: "syntax-error", usage: "/goal resume [--budget <positive-integer>]" };
    }
    if (first === "replace") {
        const rest = tokens.slice(1).join(" ").trim();
        if (rest.startsWith("--budget") && !/^--budget\s+\d+\s+.+$/s.test(rest)) {
            return { kind: "syntax-error", usage: "/goal replace [--budget <positive-integer>] <objective>" };
        }
        return parseCreateLike(rest, "replace");
    }
    if (first === "budget") {
        const rest = tokens.slice(1).join(" ").trim();
        if (rest === "" || rest === "none") {
            return { kind: "budget", budget: undefined };
        }
        if (/^\d+$/.test(rest)) {
            const n = parseInt(rest, 10);
            return { kind: "budget", budget: n };
        }
        return { kind: "syntax-error", usage: "/goal budget <positive-integer>|none" };
    }
    if (first === "plan-file" || first === "planfile") {
        const rest = tokens.slice(1).join(" ").trim();
        if (!rest || rest === "show") {
            return { kind: "plan-file-show" };
        }
        if (rest === "on" || rest === "true" || rest === "1" || rest === "yes") {
            return { kind: "plan-file-set", enabled: true };
        }
        if (rest === "off" || rest === "false" || rest === "0" || rest === "no") {
            return { kind: "plan-file-set", enabled: false };
        }
        return { kind: "syntax-error", usage: "/goal plan-file on|off" };
    }
    if (first === "verify") {
        const rest = tokens.slice(1).join(" ").trim();
        if (!rest) {
            return { kind: "verify-show" };
        }
        return { kind: "verify-set", policyRaw: rest };
    }
    return parseCreateLike(trimmed, "create");
}
function parseCreateLike(rest: string, kind: "create" | "replace"): ParsedGoalCommand {
    const trimmed = rest.trim();
    const budgetMatch = trimmed.match(/^--budget\s+(\d+)\s+(.+)$/s);
    if (budgetMatch) {
        return {
            kind,
            objective: budgetMatch[2].trim(),
            budget: parseInt(budgetMatch[1], 10),
        };
    }
    if (/^--budget/.test(trimmed)) {
        const usage = kind === "create"
            ? "/goal [--budget <positive-integer>] <objective>"
            : "/goal replace [--budget <positive-integer>] <objective>";
        return { kind: "syntax-error", usage };
    }
    return { kind, objective: trimmed, budget: undefined };
}
