import type { Metadata } from "next";
import "./globals.css";
import "./design-system.css";
import {ThemeProvider} from "./components/theme-provider";
import {appearanceBootstrap} from "./lib/appearance.mjs";
import {SessionProvider} from "./components/session-provider";
import "./auth.css";
import "./esf-graph.css";
import "./analysis-center.css";
import "./review-history.css";
import "./financial-profile.css";
import "./case-balance.css";

export const metadata: Metadata = {
  title: "Vestigo",
  description:
    "Информационно-аналитическая система сопровождения экономических расследований",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{__html:appearanceBootstrap}}/></head>
      <body><ThemeProvider><SessionProvider>{children}</SessionProvider></ThemeProvider></body>
    </html>
  );
}
