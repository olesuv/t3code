import {
  createFilesystemEnvironmentAtoms,
  resolveFilesystemReadAccess,
} from "@t3tools/client-runtime/state/filesystem";

import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironmentQuery } from "./query";
import { useEnvironmentPresentation } from "./presentation";
import { environmentSession } from "./session";

import { connectionAtomRuntime } from "../connection/runtime";

export const filesystemEnvironment = createFilesystemEnvironmentAtoms(connectionAtomRuntime);

/** Resolves the destination environment's file grant before displaying cached host files. */
export function useFilesystemReadAccess(environmentId: EnvironmentId | null) {
  const environment = useEnvironmentPresentation(environmentId);
  const session = useEnvironmentQuery(
    environmentId === null ? null : environmentSession.sessionStateAtom(environmentId),
  );
  return resolveFilesystemReadAccess({
    isCatalogReady: environment.isReady,
    connection: environment.presentation?.connection ?? null,
    session: session.data,
    sessionError: session.error,
  });
}
