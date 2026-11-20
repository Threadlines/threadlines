import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

import { ChatsDestinationView } from "../components/ChatsDestinationView";
import {
  requestGeneralChatsReveal,
  useGeneralChatsInThreads,
} from "../components/chats/generalChatsPlacement";

/**
 * General Chats' own address. Where the chats have their own page it shows
 * it. Where this device lists them in a section of Threads, every way here
 * (an old link, a place link in a reply) lands on Threads instead, with the
 * list showing and the section open (GeneralChatsRevealer).
 */
function ChatsRoute() {
  const inThreads = useGeneralChatsInThreads();
  return inThreads ? <OpenGeneralChatsInThreads /> : <ChatsDestinationView />;
}

function OpenGeneralChatsInThreads() {
  useEffect(() => {
    requestGeneralChatsReveal();
  }, []);
  return null;
}

export const Route = createFileRoute("/_chat/chats")({
  component: ChatsRoute,
});
