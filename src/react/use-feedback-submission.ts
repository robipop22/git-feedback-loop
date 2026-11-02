import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedbackClient } from "../browser/client.js";
import type { FeedbackReceipt, FeedbackSubmission } from "../issue.js";

const httpStatus = (error: unknown): number | undefined =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  typeof error.status === "number"
    ? error.status
    : undefined;

/** Handles immutable retries and receipts independently of the host's UI components. */
export const useFeedbackSubmission = ({
  client,
  storageKey,
  polling = true,
  pollIntervalMs = 5000,
}: {
  client: FeedbackClient;
  storageKey: string;
  polling?: boolean;
  pollIntervalMs?: number;
}) => {
  const [receipt, setReceipt] = useState<FeedbackReceipt>();
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<unknown>();
  const [editableError, setEditableError] = useState(false);
  const scope = useRef({ storageKey, client, epoch: 0 });
  if (scope.current.storageKey !== storageKey || scope.current.client !== client) {
    scope.current = { storageKey, client, epoch: scope.current.epoch + 1 };
  }
  const reference = useRef<string | undefined>(undefined);
  const payload = useRef<FeedbackSubmission | undefined>(undefined);
  const sending = useRef(false);
  const mounted = useRef(true);
  const valid = (active: typeof scope.current, epoch: number, id?: string) =>
    mounted.current &&
    scope.current === active &&
    active.epoch === epoch &&
    (id === undefined || reference.current === id);
  const forget = (key: string) => {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* Storage is optional. */
    }
  };
  const reset = useCallback(() => {
    scope.current.epoch++;
    reference.current = undefined;
    payload.current = undefined;
    sending.current = false;
    setReceipt(undefined);
    setBusy(false);
    setSubmitted(false);
    setError(undefined);
    setEditableError(false);
    forget(storageKey);
  }, [storageKey]);
  const refresh = useCallback(
    async (id = reference.current) => {
      if (!id) return;
      const active = scope.current;
      const epoch = active.epoch;
      try {
        const saved = await client.status(id);
        if (!valid(active, epoch, id)) return;
        setReceipt(saved);
        setError(undefined);
      } catch (caught) {
        if (!valid(active, epoch, id)) return;
        if ([403, 404].includes(httpStatus(caught) ?? 0)) reset();
        else setError(caught);
      }
    },
    [client, reset],
  );
  useEffect(() => {
    mounted.current = true;
    reference.current = undefined;
    payload.current = undefined;
    sending.current = false;
    setReceipt(undefined);
    setBusy(false);
    setSubmitted(false);
    setError(undefined);
    setEditableError(false);
    try {
      const restored = sessionStorage.getItem(storageKey);
      if (restored) {
        reference.current = restored;
        void refresh(restored);
      }
    } catch {
      /* Storage is optional. */
    }
    return () => {
      mounted.current = false;
      scope.current.epoch++;
    };
  }, [storageKey, client, refresh]);
  useEffect(() => {
    if (
      !polling ||
      !receipt ||
      receipt.status !== "pending" ||
      !receipt.configured ||
      receipt.attentionRequired
    )
      return;
    const timer = setInterval(() => void refresh(receipt.id), Math.max(1000, pollIntervalMs));
    return () => clearInterval(timer);
  }, [receipt, polling, pollIntervalMs, refresh]);
  const submit = async (input: Omit<FeedbackSubmission, "id">) => {
    if (sending.current) return;
    const active = scope.current;
    const epoch = active.epoch;
    payload.current ??= { ...input, id: crypto.randomUUID() };
    const current = payload.current;
    reference.current = current.id;
    sending.current = true;
    setBusy(true);
    setSubmitted(true);
    setError(undefined);
    setEditableError(false);
    try {
      const saved = await client.submit(current);
      if (!valid(active, epoch, current.id)) return;
      setReceipt(saved);
      try {
        sessionStorage.setItem(storageKey, saved.id);
      } catch {
        /* Storage is optional. */
      }
    } catch (caught) {
      if (!valid(active, epoch, current.id)) return;
      const status = httpStatus(caught);
      const editable =
        status !== undefined && status >= 400 && status < 500 && ![401, 403, 429].includes(status);
      if (editable) {
        payload.current = undefined;
        reference.current = undefined;
        setSubmitted(false);
      }
      setError(caught);
      setEditableError(editable);
    } finally {
      if (valid(active, epoch)) {
        sending.current = false;
        setBusy(false);
      }
    }
  };
  return {
    receipt,
    busy,
    submitted,
    error,
    editableError,
    submit,
    refresh,
    reset,
    clearError: () => {
      setError(undefined);
      setEditableError(false);
    },
  };
};
