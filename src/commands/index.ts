import * as vscode from "vscode";
import type { ExtensionController } from "../controller";

type ThenableOrPromiseOrVoid = void | Thenable<void> | Promise<void>;

/** Registers every user-facing command; all of them route through the controller. */
export function registerCommands(controller: ExtensionController, showLogs: () => void): vscode.Disposable {
  const register = (id: string, action: () => ThenableOrPromiseOrVoid): vscode.Disposable =>
    vscode.commands.registerCommand(id, action);

  return vscode.Disposable.from(
    register("opencodeCursorUI.openChat", () => controller.setView("chat")),
    register("opencodeCursorUI.newChat", () => controller.newChat()),
    register("opencodeCursorUI.openHistory", () => controller.openHistory()),
    register("opencodeCursorUI.installOpencode", () => controller.installRuntime()),
    register("opencodeCursorUI.startOpencode", () => controller.startRuntime()),
    register("opencodeCursorUI.stopOpencode", () => controller.stopRuntime()),
    register("opencodeCursorUI.restartOpencode", () => controller.restartRuntime()),
    register("opencodeCursorUI.updateOpencode", () => controller.updateRuntime()),
    register("opencodeCursorUI.selectModel", () => controller.selectModelInteractive()),
    register("opencodeCursorUI.selectAgent", () => controller.selectAgentInteractive()),
    register("opencodeCursorUI.setDefaultModel", () => controller.setDefaultModelInteractive()),
    register("opencodeCursorUI.setProviderKey", () => controller.setProviderKeyInteractive()),
    register("opencodeCursorUI.addProvider", () => controller.addProviderInteractive()),
    register("opencodeCursorUI.setDefaultAgent", () => controller.setDefaultAgentInteractive()),
    register("opencodeCursorUI.openRuntimeSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "opencodeCursorUI."),
    ),
    register("opencodeCursorUI.openControlCenter", () => controller.setView("control")),
    register("opencodeCursorUI.showRuntimeLogs", () => showLogs()),
    register("opencodeCursorUI.reconnect", () => controller.reconnect()),
    register("opencodeCursorUI.connectExternalServer", () => controller.connectExternal()),
    register("opencodeCursorUI.sendSelectionToOpencode", () => controller.sendSelection()),
    register("opencodeCursorUI.interruptSession", () => controller.interrupt()),
  );
}
