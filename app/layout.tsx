import type { Metadata } from "next";
import { DM_Sans, Fraunces } from "next/font/google";
import "./globals.css";

const sans = DM_Sans({ variable: "--font-sans", subsets: ["latin"] });
const display = Fraunces({ variable: "--font-display", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Estúdio xCatarina — Timelapses",
  description: "Cria timelapses das lives da xCatarina em 16:9 ou 9:16.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt"><body className={`${sans.variable} ${display.variable}`}>{children}</body></html>;
}
