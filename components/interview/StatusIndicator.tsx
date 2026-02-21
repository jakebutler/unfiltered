import { Badge } from "@/components/ui/badge";

type Status = "listening" | "thinking" | "speaking";

export function StatusIndicator({ status }: { status: Status }) {
  const config = {
    listening: { label: "Listening", className: "bg-green-100 text-green-800" },
    thinking:  { label: "Thinking…", className: "bg-yellow-100 text-yellow-800" },
    speaking:  { label: "Speaking", className: "bg-blue-100 text-blue-800" },
  };
  const { label, className } = config[status];
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-block w-2 h-2 rounded-full animate-pulse ${status === "listening" ? "bg-green-500" : status === "thinking" ? "bg-yellow-500" : "bg-blue-500"}`} />
      <Badge className={className}>{label}</Badge>
    </div>
  );
}
