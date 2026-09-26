/**
 * console 的构建配置（docs/services/console/README.md）。
 *
 * - `vite build`：正式构建，产物进 dist/，由 control 同源托管（ADR-0009）。
 * - `vite --mode sample` / `vite build --mode sample`：样板数据模式，数据全部虚构、不发网络请求，供本机开发与浏览器回归。
 * - Tuffex 组件的 CSS 由官方的按需样式插件按组件的样式依赖补全；UnoCSS 只用图标预设（Carbon 图标集），不引入原子类样式体系。
 */
import presetIcons from "@unocss/preset-icons";
import UnoCSS from "@unocss/vite";
import vue from "@vitejs/plugin-vue";
import tuffexOnDemandStyle from "@talex-touch/tuffex/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * Tuffex 组件内部按类名引用的 Carbon 图标（TxEmptyState 各变体的默认图标、TxStatusBadge 的状态图标）。
 * UnoCSS 不扫描 node_modules，这些类名要列出来才会生成；浏览器回归会核对页面上每个图标类都有图形。
 */
const TUFFEX_INTERNAL_ICONS = [
  "i-carbon-warning",
  "i-carbon-view",
  "i-carbon-search",
  "i-carbon-locked",
  "i-carbon-incomplete",
  "i-carbon-direction-straight-right",
  "i-carbon-data-base",
  "i-carbon-cloud-offline",
  "i-carbon-checkmark-outline",
  "i-carbon-circle-dash",
  "i-carbon-close-outline",
  "i-carbon-information",
];

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    vue(),
    UnoCSS({
      configFile: false,
      presets: [presetIcons({ extraProperties: { display: "inline-block", "vertical-align": "middle" } })],
      safelist: TUFFEX_INTERNAL_ICONS,
      content: { pipeline: { include: [/\.(?:vue|ts)(?:$|\?)/] } },
    }),
    tuffexOnDemandStyle(),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
