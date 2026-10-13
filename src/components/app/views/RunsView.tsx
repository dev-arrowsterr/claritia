"use client";

import { Play } from "../../Icons";
import { Empty, Page, type ViewProps } from "../ui";

export function RunsView({ project }: ViewProps) {
  return (
    <Page icon={<Play size={14} />} title="Runs" count={0}>
      <Empty icon={<Play size={16} />} title={project ? "Every run will show up here, with its video." : "Add a project first."} />
    </Page>
  );
}
