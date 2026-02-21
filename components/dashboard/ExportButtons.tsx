"use client";
import { Button } from "@/components/ui/button";
import { generateMarkdownReport } from "@/lib/export/report";
import type { ReportData } from "@/lib/export/report";

function downloadText(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExportButtons({ reportData }: { reportData: ReportData }) {
  const handleMarkdown = () => {
    const md = generateMarkdownReport(reportData);
    downloadText(md, `unfiltered-report-${reportData.sessionId.slice(-8)}.md`, "text/markdown");
  };

  const handleJson = () => {
    downloadText(JSON.stringify(reportData, null, 2), `unfiltered-report-${reportData.sessionId.slice(-8)}.json`, "application/json");
  };

  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={handleMarkdown}>Export Markdown</Button>
      <Button variant="outline" size="sm" onClick={handleJson}>Export JSON</Button>
    </div>
  );
}
