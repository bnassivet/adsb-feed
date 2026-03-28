"use client";
import { useState, useEffect, useCallback } from "react";
import {
  getEventsOfInterest,
  createEventOfInterest,
  updateEventOfInterest,
  deleteEventOfInterest,
} from "@/lib/commands";
import type {
  EventOfInterest,
  CreateEventOfInterest,
  UpdateEventOfInterest,
  EventOfInterestQuery,
} from "@/lib/types";

/**
 * Manages events of interest: fetch, create, update, delete.
 * Fetches all events on mount. Each mutation re-fetches the list.
 * Gracefully handles "Storage not available" (empty list, no error).
 */
export function useEventsOfInterest(query?: EventOfInterestQuery) {
  const [events, setEvents] = useState<EventOfInterest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEvents = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await getEventsOfInterest(query ?? {});
      setEvents(result);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("Storage not available")) {
        setEvents([]);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const createEvent = useCallback(
    async (event: CreateEventOfInterest): Promise<EventOfInterest> => {
      const created = await createEventOfInterest(event);
      await fetchEvents();
      return created;
    },
    [fetchEvents]
  );

  const updateEvent = useCallback(
    async (event: UpdateEventOfInterest): Promise<EventOfInterest> => {
      const updated = await updateEventOfInterest(event);
      await fetchEvents();
      return updated;
    },
    [fetchEvents]
  );

  const removeEvent = useCallback(
    async (id: string): Promise<void> => {
      await deleteEventOfInterest(id);
      await fetchEvents();
    },
    [fetchEvents]
  );

  const removeEvents = useCallback(
    async (ids: string[]): Promise<void> => {
      for (const id of ids) {
        await deleteEventOfInterest(id);
      }
      await fetchEvents();
    },
    [fetchEvents]
  );

  return {
    events,
    loading,
    error,
    createEvent,
    updateEvent,
    removeEvent,
    removeEvents,
    refresh: fetchEvents,
  };
}
