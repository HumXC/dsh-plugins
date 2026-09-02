import z from "@deepseek-ai/schemastery";

export interface Config {
  /** web 前端基础 URL(含 scheme+host+port);缺省:DSH_WEB_URL → 运行时由 webServer 推导。 */
  webBaseUrl?: string;
  /** SSE 导航通道路径,避免与未来插件撞名。 */
  eventsPath: string;
  /** 托盘图标尺寸(px)。 */
  iconSize: number;
  /** 浅色面板兜底:白色 logo 加 1px 深色描边。 */
  iconOutline: boolean;
  /** logo 填充色(十六进制 #rrggbb,默认 DSH 品牌蓝)。 */
  iconColor: string;
  /** 完成状态点颜色(十六进制 #rrggbb)。 */
  dotGreen: string;
  /** 需人工介入状态点颜色。 */
  dotYellow: string;
  /** 异常状态点颜色。 */
  dotRed: string;
}

export const Config = z.object({
  webBaseUrl: z.string(), // z.object 输入侧字段本就可选,无需 .optional()

  eventsPath: z.string().default("/plugins/dsh-tray/events"),
  iconSize: z.number().default(22),
  iconOutline: z.boolean().default(false),
  iconColor: z.string().default("#4d6bfe"),
  dotGreen: z.string().default("#22c55e"),
  dotYellow: z.string().default("#eab308"),
  dotRed: z.string().default("#ef4444"),
});