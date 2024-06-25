import { z } from "zod"

export type CallbacksConfig = {
    // callbacks
    checkPodHealth: (data: {
        clusterConfig: ClusterConfig
        podId: string
    }) => Promise<boolean>

    onPodListUpdate?: (data: {
        clusterConfig: ClusterConfig
        podIds: string[]
    }) => Promise<void>

    afterPodStart?: (data: {
        clusterConfig: ClusterConfig
        podId: string
    }) => Promise<void>

    afterPodRestart?: (data: {
        clusterConfig: ClusterConfig
        podId: string
    }) => Promise<void>
}

export const clusterconfigSchema = z.object({
    id: z.string(),
    enabled: z.boolean(),
    targetPodCount: z.number(),
    checkIntervalMin: z.number(),
    checkTimeoutS: z.number(),
    healthyCheckCount: z.number(),
    unhealthyCheckCount: z.number(),
    restartCountToDrop: z.number(),
    startTimeoutMin: z.number(),
    restartTimeoutMin: z.number(),
    connectorAdd: z.record(z.unknown()).optional(),
})

export type ClusterConfig = z.output<typeof clusterconfigSchema>

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

    lastStart: string | null = null
    lastRestart: string | null = null
    lastHealthy: string | null = null
    lastCheck: string | null = null

    constructor(id: string) {
        this.id = id
    }

    start() {
        this.status = "starting"
        this.lastStart = new Date().toISOString()
    }

    restart() {
        this.restartCount++
        this.healthyCheckCount = 0
        this.unhealthyCheckCount = 0
        this.status = "restarting"
        this.lastRestart = new Date().toISOString()
        this.lastHealthy = null
    }

    get isStarting() {
        return (
            this.lastStart !== null &&
            this.restartCount === 0 &&
            this.lastHealthy === null
        )
    }

    get isRestarting() {
        return (
            this.lastRestart !== null &&
            this.restartCount > 0 &&
            (this.lastHealthy === null ||
                new Date(this.lastHealthy).getTime() <
                    new Date(this.lastRestart).getTime())
        )
    }
}
