import { ChartNoAxesCombined, CreditCard, Layers3, MessageSquare, Plug2 } from "lucide-react";

export const navigation = [
  { id: "overview", label: "Overview", icon: ChartNoAxesCombined },
  { id: "sessions", label: "Sessions", icon: MessageSquare },
  { id: "models", label: "Models", icon: Layers3 },
  { id: "subscriptions", label: "Subscriptions", icon: CreditCard },
  { id: "connections", label: "Connections", icon: Plug2 },
] as const;

export type View = (typeof navigation)[number]["id"];
