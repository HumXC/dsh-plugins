import z from "@deepseek-ai/schemastery";

export interface Config {
    /** HTTP(S) origin serving this DSH Web instance. */
    webBaseUrl?: string;
    /** Tray icon size in pixels, clamped to 16..256 by normalizeConfig. */
    iconSize: number;
    iconOutline: boolean;
    iconColor: string;
    dotGreen: string;
    dotYellow: string;
    dotRed: string;
}

export const Config = z.object({
    webBaseUrl: z.string().required(false),
    iconSize: z.number().default(22),
    iconOutline: z.boolean().default(false),
    iconColor: z.string().default("#4d6bfe"),
    dotGreen: z.string().default("#22c55e"),
    dotYellow: z.string().default("#eab308"),
    dotRed: z.string().default("#ef4444"),
});

export function normalizeConfig(config: Config): Config {
    return { ...config, iconSize: Math.min(256, Math.max(16, Math.round(config.iconSize))) };
}
