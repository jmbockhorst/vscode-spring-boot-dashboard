// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import * as vscode from "vscode";
import { BootAppManager } from "./BootAppManager";
import { BootApp, AppState } from "./BootApp";
import { findJvm } from "@pivotal-tools/jvm-launch-utils";
import * as path from "path";
import { readAll } from "./stream-util";
const getPort = require("get-port");

export class Controller {
    private _outputChannels: Map<string, vscode.OutputChannel>;
    private _manager: BootAppManager;
    private _context: vscode.ExtensionContext;

    constructor(manager: BootAppManager, context: vscode.ExtensionContext) {
        this._outputChannels = new Map<string, vscode.OutputChannel>();
        this._manager = manager;
        this._context = context;
    }

    public getAppList(): BootApp[] {
        return this._manager.getAppList();
    }

    public async startBootApps(debug?: boolean) {
        const appsToStart = await vscode.window.showQuickPick(
            this.getAppList().filter(app => app.state !== AppState.RUNNING).map(app => ({ label: app.name, path: app.path })), /** items */
            { canPickMany: true, placeHolder: `Select apps to ${debug ? "debug" : "start"}.` } /** options */
        );
        if (appsToStart !== undefined) {
            const appPaths = appsToStart.map(elem => elem.path);
            await Promise.all(this.getAppList().filter(app => appPaths.indexOf(app.path) > -1).map(app => this.startBootApp(app)));
        }
    }

    public async startBootApp(app: BootApp, debug?: boolean): Promise<void> {
        const mainClasData = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `Resolving main classes for ${app.name}...` },
            () => { return this._getMainClass(app); }
        );
        if (mainClasData === null) {
            vscode.window.showWarningMessage("No main class is found.");
            return;
        }
        if (mainClasData === undefined) {
            return;
        }

        let targetConfig = this._getLaunchConfig(mainClasData);
        if (!targetConfig) {
            targetConfig = await this._createNewLaunchConfig(mainClasData);
        }
        app.activeSessionName = targetConfig.name;
        let jmxport = await getPort();
        app.jmxPort = jmxport;
        let vmArgs = '-Dcom.sun.management.jmxremote ' +
            `-Dcom.sun.management.jmxremote.port=${jmxport} ` +
            '-Dcom.sun.management.jmxremote.authenticate=false ' +
            '-Dcom.sun.management.jmxremote.ssl=false ' +
            '-Djava.rmi.server.hostname=localhost ' +
            '-Dspring.application.admin.enabled=true';
        if (targetConfig.vmArgs) {
            //TODO: smarter merge? What if user is trying to enable jmx themselves on a specific port they choose, for example?
            vmArgs = vmArgs + ' ' + targetConfig.vmArgs;
        }
        const cwdUri: vscode.Uri = vscode.Uri.parse(app.path);
        await vscode.debug.startDebugging(
            vscode.workspace.getWorkspaceFolder(cwdUri),
            Object.assign({}, targetConfig, {
                noDebug: !debug,
                cwd: cwdUri.fsPath,
                vmArgs
            })
        );
    }

    public onDidStartBootApp(session: vscode.DebugSession): void {
        const app: BootApp | undefined = this._manager.getAppList().find((elem: BootApp) => elem.activeSessionName === session.name);
        if (app) {
            this._manager.bindDebugSession(app, session);
            this._setState(app, AppState.RUNNING);
        }
    }

    public async stopBootApp(app: BootApp, restart?: boolean): Promise<void> {
        // TODO: How to send a shutdown signal to the app instead of killing the process directly?
        const session: vscode.DebugSession | undefined = this._manager.getSessionByApp(app);
        if (session) {
            await session.customRequest("disconnect", { restart: !!restart });
        } else {
            // What if session not found? Force to set STATE_INACTIVE?
        }
    }

    public onDidStopBootApp(session: vscode.DebugSession): void {
        const app = this._manager.getAppBySession(session);
        if (app) {
            this._setState(app, AppState.INACTIVE);
        }
    }

    public async openBootApp(app: BootApp): Promise<void> {
        let jvm = await findJvm();
        if (!jvm) {
            throw new Error("Couldn't find a JVM to run Java code");
        }
        let jmxport = app.jmxPort;
        if (jmxport) {
            let jmxurl = `service:jmx:rmi:///jndi/rmi://localhost:${jmxport}/jmxrmi`;
            if (jvm) {
                let javaProcess = jvm.jarLaunch(
                    path.resolve(this._context.extensionPath, "lib", "java-extension.jar"),
                    [
                        "-Djmxurl=" + jmxurl
                    ]
                );
                let port = parseInt(await readAll(javaProcess.stdout));
                if (port > 0) {
                    vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(`http://localhost:${port}/`));
                } else {
                    let err = await readAll(javaProcess.stderr);
                    console.log(err);
                    vscode.window.showErrorMessage("Couldn't determine port app is running on");
                }
            }
        }
    }

    private _setState(app: BootApp, state: AppState): void {
        const output: vscode.OutputChannel = this._getOutput(app);
        app.state = state;
        output.appendLine(`${app.name} is ${state} now.`);
        this._manager.fireDidChangeApps();
    }

    private _getChannelName(app: BootApp): string {
        return `BootApp_${app.name}`;
    }

    private _getOutput(app: BootApp): vscode.OutputChannel {
        const channelName: string = this._getChannelName(app);
        let output: vscode.OutputChannel | undefined = this._outputChannels.get(channelName);
        if (!output) {
            output = vscode.window.createOutputChannel(channelName);
            this._outputChannels.set(channelName, output);
        }
        return output;
    }

    private async _getMainClass(app: BootApp): Promise<MainClassData | null> {
        // Note: Command `vscode.java.resolveMainClass` is implemented in extension `vscode.java.resolveMainClass`
        const mainClassList = await vscode.commands.executeCommand('java.execute.workspaceCommand', 'vscode.java.resolveMainClass', app.path);
        if (mainClassList && mainClassList instanceof Array && mainClassList.length > 0) {
            return mainClassList.length === 1 ? mainClassList[0] :
                await vscode.window.showQuickPick(mainClassList.map(x => Object.assign({ label: x.mainClass }, x)), { placeHolder: `Specify the main class for ${app.name}` });
        }
        return Promise.resolve(null);
    }

    private _getLaunchConfig(mainClasData: MainClassData) {
        const launchConfigurations: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("launch", vscode.Uri.file(mainClasData.filePath));
        const rawConfigs: vscode.DebugConfiguration[] = launchConfigurations.configurations;
        return rawConfigs.find(conf => conf.type === "java" && conf.request === "launch" && conf.mainClass === mainClasData.mainClass && conf.projectName === mainClasData.projectName);
    }

    private _constructLaunchConfigName(mainClass: string, projectName: string) {
        const prefix = "Spring Boot-";
        let name = prefix + mainClass.substr(mainClass.lastIndexOf(".") + 1);
        if (projectName !== undefined) {
            name += `<${projectName}>`;
        }
        return name;
    }

    private async _createNewLaunchConfig(mainClasData: MainClassData): Promise<vscode.DebugConfiguration> {
        const newConfig = {
            type: "java",
            name: this._constructLaunchConfigName(mainClasData.mainClass, mainClasData.projectName),
            request: "launch",
            cwd: "${workspaceFolder}",
            console: "internalConsole",
            mainClass: mainClasData.mainClass,
            projectName: mainClasData.projectName,
            args: "",
        };
        const launchConfigurations: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("launch", vscode.Uri.file(mainClasData.filePath));
        const configs: vscode.DebugConfiguration[] = launchConfigurations.configurations;
        configs.push(newConfig);
        await launchConfigurations.update("configurations", configs, vscode.ConfigurationTarget.WorkspaceFolder);
        return newConfig;
    }
}

interface MainClassData {
    filePath: string;
    mainClass: string;
    projectName: string;
}
