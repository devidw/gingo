export type GlobalConfig = {
    // fallbackWaitAfterRemoveNoticeMin: number
}

export type ClusterConfig = {
    id: string
    targetPodCount: number
    checkIntervalMin: number
    checkTimeoutS: number
    healthyCheckCount: number
    unhealthyCheckCount: number
    restartCountToDrop: number
    connectorAdd?: Record<string, unknown>

    // callbacks
    checkPodHealth: (podId: string) => Promise<boolean>
    onPodListUpdate?: (podIds: string[]) => Promise<void>
    afterPodStart?: (podId: string) => Promise<void>
    afterPodRestart?: (podId: string) => Promise<void>
}

export type Config = {
    global: GlobalConfig
    clusters: ClusterConfig[]
}

export type PodStatus =
    | "healthy"
    | "unhealthy"
    | "grey"
    | "starting"
    | "restarting"

export type ClusterState = {
    checkStatus: "idle" | "busy"
    config: ClusterConfig
    pods: Pod[]
    interval: NodeJS.Timeout | null
}

export type State = {
    clusters: ClusterState[]
}

export class Pod {
    id: string
    status: PodStatus = "grey"
    healthyCheckCount = 0
    unhealthyCheckCount = 0
    restartCount = 0
    extra: Record<string, unknown> = {}

    constructor(id: string) {
        this.id = id
    }
}
