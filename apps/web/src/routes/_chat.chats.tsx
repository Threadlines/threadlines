import { createFileRoute } from "@tanstack/react-router";

import { ChatsDestinationView } from "../components/ChatsDestinationView";

export const Route = createFileRoute("/_chat/chats")({
  component: ChatsDestinationView,
});
