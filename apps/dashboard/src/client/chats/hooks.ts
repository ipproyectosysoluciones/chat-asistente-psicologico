import { useEffect, useState } from "react";

import {
  chatsErrorMessage,
  fetchChatDetail,
  fetchChats,
  type ChatDetail,
  type ChatList,
} from "./api";

/**
 * Chats data hooks (task 5.2 frontend, REQ-DASH-9): discriminated-union state
 * (loading / error / ready) so every async view renders a loading state, an
 * error state with retry, or the data — never a partial render. `reload()`
 * drives the retry button; switching session/page/token re-fetches.
 */

export type Loadable<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T };

export function useChats(
  token: string,
  query: { limit: number; offset: number }
): { state: Loadable<ChatList>; reload(): void } {
  const [state, setState] = useState<Loadable<ChatList>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void fetchChats(token, query)
      .then((data) => {
        if (!cancelled) {
          setState({ status: "ready", data });
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: chatsErrorMessage(caught) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, query.limit, query.offset, attempt]);

  return {
    state,
    reload() {
      setAttempt((current) => current + 1);
    },
  };
}

export function useChatDetail(
  token: string,
  sessionId: string
): { state: Loadable<ChatDetail>; reload(): void } {
  const [state, setState] = useState<Loadable<ChatDetail>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void fetchChatDetail(token, sessionId)
      .then((data) => {
        if (!cancelled) {
          setState({ status: "ready", data });
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: chatsErrorMessage(caught) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, sessionId, attempt]);

  return {
    state,
    reload() {
      setAttempt((current) => current + 1);
    },
  };
}
