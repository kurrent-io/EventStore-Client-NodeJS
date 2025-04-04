import { Empty } from "../../generated/shared_pb";
import { UpdateReq } from "../../generated/persistent_pb";
import {
  PersistentSubscriptionsClient,
  PersistentSubscriptionsService,
} from "../../generated/persistent_grpc_pb";

import { debug, convertToCommandError, UnsupportedError } from "../utils";
import { END, START } from "../constants";
import { Client } from "../Client";
import type { BaseOptions } from "../types";

import type { PersistentSubscriptionToAllSettings } from "./utils/persistentSubscriptionSettings";
import { settingsToGRPC } from "./utils/settingsToGRPC";

export type UpdatePersistentSubscriptionToAllOptions = BaseOptions;

declare module "../Client" {
  interface Client {
    /**
     * Updates a persistent subscription to all configuration.
     * @param groupName - A group name.
     * @param settings - PersistentSubscriptionToAll settings.
     * @see {@link persistentSubscriptionToAllSettingsFromDefaults}
     * @param options - Command options.
     */
    updatePersistentSubscriptionToAll(
      groupName: string,
      settings: PersistentSubscriptionToAllSettings,
      options?: UpdatePersistentSubscriptionToAllOptions
    ): Promise<void>;
  }
}

Client.prototype.updatePersistentSubscriptionToAll = async function (
  this: Client,
  groupName: string,
  settings: PersistentSubscriptionToAllSettings,
  { ...baseOptions }: UpdatePersistentSubscriptionToAllOptions = {}
): Promise<void> {
  if (!(await this.supports(PersistentSubscriptionsService.update, "all"))) {
    throw new UnsupportedError("updatePersistentSubscriptionToAll", "21.10");
  }

  const req = new UpdateReq();
  const options = new UpdateReq.Options();
  const allOptions = new UpdateReq.AllOptions();
  const reqSettings = settingsToGRPC(settings, UpdateReq.Settings);

  switch (settings.startFrom) {
    case START: {
      allOptions.setStart(new Empty());
      break;
    }
    case END: {
      allOptions.setEnd(new Empty());
      break;
    }
    default: {
      const position = new UpdateReq.Position();
      position.setCommitPosition(settings.startFrom.commit.toString(10));
      position.setPreparePosition(settings.startFrom.prepare.toString(10));
      allOptions.setPosition(position);
      break;
    }
  }

  options.setGroupName(groupName);
  options.setSettings(reqSettings);
  options.setAll(allOptions);

  req.setOptions(options);

  debug.command("updatePersistentSubscriptionToAll: %O", {
    groupName,
    settings,
    options: baseOptions,
  });
  debug.command_grpc("updatePersistentSubscriptionToAll: %g", req);

  return this.execute(
    PersistentSubscriptionsClient,
    "updatePersistentSubscriptionToAll",
    (client) =>
      new Promise<void>((resolve, reject) => {
        client.update(req, ...this.callArguments(baseOptions), (error) => {
          if (error) return reject(convertToCommandError(error));
          return resolve();
        });
      })
  );
};
