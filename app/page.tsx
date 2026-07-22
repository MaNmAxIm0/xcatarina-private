import type { Metadata } from "next";
import { TimelapseStudio } from "./TimelapseStudio";

export const metadata: Metadata = {
  title: "Estúdio xCatarina",
  description: "Cria timelapses das lives em formato horizontal ou vertical.",
};

export default function Home() {
  return <TimelapseStudio />;
}
