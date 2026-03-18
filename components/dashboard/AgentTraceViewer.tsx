"use client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface AgentTraceViewerProps {
  sessionId: string;
}

interface ActionTrace {
  _id: string;
  action: string;
  t: number;
  description: string;
  target?: string;
  text?: string;
}

interface ReasoningTrace {
  _id: string;
  type: string;
  t: number;
  content: string;
}

// Demo traces for display when Convex is not connected
const demoTraces = {
  actions: [
    { _id: "a1", action: "navigate", t: Date.now() - 60000, description: "Navigated to prototype homepage" },
    { _id: "a2", action: "click", t: Date.now() - 55000, description: "Clicked on 'Products' menu", target: "products-menu" },
    { _id: "a3", action: "think_aloud", t: Date.now() - 50000, description: "Looking for the search feature" },
    { _id: "a4", action: "click", t: Date.now() - 45000, description: "Clicked search input", target: "search-input" },
    { _id: "a5", action: "type", t: Date.now() - 40000, description: "Typed search query", target: "search-input", text: "wireless headphones" },
  ] as ActionTrace[],
  reasoning: [
    { _id: "r1", type: "observation", t: Date.now() - 59000, content: "The homepage shows a clean layout with navigation at the top. I notice a hero section and featured products." },
    { _id: "r2", type: "plan", t: Date.now() - 58000, content: "I need to find wireless headphones. I'll look for a search feature or browse the products category." },
    { _id: "r3", type: "reflection", t: Date.now() - 48000, content: "The search input appeared when I clicked on the search icon. This is a common pattern but wasn't immediately obvious." },
    { _id: "r4", type: "friction", t: Date.now() - 35000, content: "FRICTION: The search results took a moment to load and there was no loading indicator." },
  ] as ReasoningTrace[],
};

export function AgentTraceViewer({ sessionId }: AgentTraceViewerProps) {
  // sessionId available for future Convex integration
  void sessionId;
  // Using demo data - in production this would use Convex
  // const traces = useQuery(api.agentTraces.getCombinedTraces, { sessionId });
  const traces = demoTraces;

  if (!traces) {
    return <div className="p-4 text-muted-foreground">Loading traces...</div>;
  }

  const { actions, reasoning } = traces;

  if (actions.length === 0 && reasoning.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Agent Traces</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">No agent traces available for this session.</p>
        </CardContent>
      </Card>
    );
  }

  const actionColors: Record<string, string> = {
    click: "bg-blue-100 text-blue-800",
    type: "bg-green-100 text-green-800",
    hover: "bg-yellow-100 text-yellow-800",
    navigate: "bg-purple-100 text-purple-800",
    select: "bg-orange-100 text-orange-800",
    scroll: "bg-gray-100 text-gray-800",
    wait: "bg-gray-100 text-gray-800",
    think_aloud: "bg-pink-100 text-pink-800",
  };

  const reasoningColors: Record<string, string> = {
    observation: "bg-blue-100 text-blue-800",
    reflection: "bg-yellow-100 text-yellow-800",
    plan: "bg-green-100 text-green-800",
    friction: "bg-red-100 text-red-800",
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent Traces</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="actions">
          <TabsList>
            <TabsTrigger value="actions">Actions ({actions.length})</TabsTrigger>
            <TabsTrigger value="reasoning">Reasoning ({reasoning.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="actions">
            <ScrollArea className="h-96">
              <div className="space-y-2">
                {actions.map((action: ActionTrace) => (
                  <div key={action._id} className="p-3 border rounded-lg">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge className={actionColors[action.action]}>
                        {action.action}
                      </Badge>
                      <span className="text-sm text-muted-foreground">
                        {new Date(action.t).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="text-sm">{action.description}</p>
                    {action.target && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Target: {action.target}
                      </p>
                    )}
                    {action.text && (
                      <p className="text-xs text-muted-foreground">
                        Text: &quot;{action.text}&quot;
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="reasoning">
            <ScrollArea className="h-96">
              <div className="space-y-2">
                {reasoning.map((trace: ReasoningTrace) => (
                  <div key={trace._id} className="p-3 border rounded-lg">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge className={reasoningColors[trace.type]}>
                        {trace.type}
                      </Badge>
                      <span className="text-sm text-muted-foreground">
                        {new Date(trace.t).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="text-sm whitespace-pre-wrap">{trace.content}</p>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
