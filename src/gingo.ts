import type { IConnector } from "./i-connector.js"
import type {
    ClusterConfig,
    ClusterState,
    Config,
    GlobalConfig,
    Pod,
    PodStatus,
    State,
} from "./types.js"

class OurTimeoutError extends Error {}

export class Gingo {
    protected globalConfig: GlobalConfig
    state: State
    protected ops: Ops
    connector: IConnector

    constructor({
        config,
        connector,
    }: {
        config: Config
        connector: IConnector
    }) {
        this.globalConfig = config.global

        this.connector = connector

        this.state = {
            clusters: config.clusters.map((clusterConfig) => {
                return {
                    checkStatus: "idle",
                    config: clusterConfig,
                    id: clusterConfig.id,
                    pods: [],
                    interval: null,
                }
            }),
        }

        this.ops = new Ops(this)
    }

    async start() {
        await this.ops.loadInitialPods()

        await Promise.all(
            this.state.clusters.map((cluster) => this.checkCluster(cluster)),
        )

        this.setupIntervals()
    }

    stop() {
        this.clearIntervals()
    }

    setupIntervals() {
        for (const cluster of this.state.clusters) {
            cluster.interval = setInterval(
                async () => {
                    await this.checkCluster(cluster)
                },
                cluster.config.checkIntervalMin * 60 * 1000,
            )
        }
    }

    clearIntervals() {
        for (const cluster of this.state.clusters) {
            if (!cluster.interval) continue
            clearInterval(cluster.interval)
        }
    }

    async checkCluster(cluster: ClusterState) {
        if (cluster.checkStatus === "busy") return

        cluster.checkStatus = "busy"

        await Promise.all(
            cluster.pods.map((pod) => this.checkClusterPod(cluster, pod)),
        )

        await this.maybePerfomClusterOps(cluster)

        cluster.checkStatus = "idle"
    }

    async checkClusterPod(cluster: ClusterState, pod: Pod) {
        const currentStatus = await this.connector.getStatus(pod)

        switch (currentStatus) {
            case "starting":
            case "restarting":
            case "unhealthy": {
                // in a state where we can not perform a health check
                pod.status = currentStatus
                return
            }
            case "grey":
            case "healthy": {
                // in a state where we can perform a health check

                if (pod.status === "starting") {
                    if (cluster.config.afterPodStart) {
                        await cluster.config.afterPodStart(pod.id)
                    }
                } else if (pod.status === "restarting") {
                    if (cluster.config.afterPodRestart) {
                        await cluster.config.afterPodRestart(pod.id)
                    }
                }

                break
            }
        }

        try {
            const out = (await Promise.race([
                cluster.config.checkPodHealth(pod.id),
                new Promise((resolve, reject) =>
                    setTimeout(() => {
                        reject(new OurTimeoutError())
                    }, cluster.config.checkTimeoutS * 1000),
                ),
            ])) as boolean

            if (!out) {
                throw new Error("unhealthy check")
            }

            pod.unhealthyCheckCount = 0
            pod.healthyCheckCount++
        } catch (e) {
            pod.healthyCheckCount = 0
            pod.unhealthyCheckCount++
        }

        if (pod.healthyCheckCount >= cluster.config.healthyCheckCount) {
            pod.status = "healthy"
            pod.restartCount = 0
        } else if (
            pod.unhealthyCheckCount >= cluster.config.unhealthyCheckCount
        ) {
            pod.status = "unhealthy"
        } else {
            pod.status = "grey"
        }

        console.info(pod)
    }

    async maybePerfomClusterOps(cluster: ClusterState) {
        switch (Cluster.status(cluster)) {
            case "healthy": {
                await this.ops.bulkOp({
                    op: "remove",
                    cluster,
                    statusList: ["unhealthy", "starting", "restarting", "grey"],
                })

                const tooMuchCount =
                    Cluster.healthyCount(cluster) -
                    cluster.config.targetPodCount

                if (tooMuchCount > 0) {
                    await this.ops.scaleDown({
                        cluster,
                        num: tooMuchCount,
                        statusListByPrio: ["healthy"],
                    })
                }

                break
            }
            case "ok": {
                await this.ops.bulkOp({
                    op: "remove",
                    cluster,
                    statusList: ["unhealthy"],
                })

                const tooMuchCount =
                    Cluster.okCount(cluster) - cluster.config.targetPodCount

                if (tooMuchCount > 0) {
                    await this.ops.scaleDown({
                        cluster,
                        num: tooMuchCount,
                        statusListByPrio: ["starting", "restarting", "grey"],
                    })
                }

                break
            }
            case "unhealthy": {
                await this.ops.bulkOp({
                    op: "restart_or_remove",
                    cluster,
                    statusList: ["unhealthy"],
                })

                if (Cluster.status(cluster) === "ok") {
                    break
                }

                const notEnoughCount =
                    cluster.config.targetPodCount - Cluster.okCount(cluster)

                if (notEnoughCount > 0) {
                    await this.ops.scaleUp({
                        cluster,
                        num: notEnoughCount,
                    })
                }

                break
            }
        }

        const podIds = cluster.pods
            .filter((a) => a.status === "healthy" || a.status === "grey")
            .map((a) => a.id)

        if (cluster.config.onPodListUpdate) {
            cluster.config.onPodListUpdate(podIds)
        }
    }
}

class Ops {
    private mom: Gingo

    constructor(mom: Gingo) {
        this.mom = mom
    }

    async scaleUp({ cluster, num }: { cluster: ClusterState; num: number }) {
        let added = 0

        while (added < num) {
            await this.addPod({ cluster })
            added++
        }
    }

    async scaleDown({
        cluster,
        num,
        statusListByPrio,
    }: {
        cluster: ClusterState
        num: number
        statusListByPrio: PodStatus[]
    }) {
        let removed = 0

        for (const status of statusListByPrio) {
            if (removed >= num) return
            await Promise.all(
                cluster.pods
                    .filter((a) => a.status === status)
                    .map((pod) => {
                        if (removed >= num) return
                        return this.removePod({ cluster, pod })
                    }),
            )
        }
    }

    async bulkOp({
        op,
        cluster,
        statusList,
    }: {
        op: "remove" | "restart" | "restart_or_remove"
        cluster: ClusterState
        statusList: PodStatus[]
    }) {
        await Promise.all(
            cluster.pods
                .filter((pod) => statusList.includes(pod.status))
                .map((pod) => {
                    switch (op) {
                        case "restart": {
                            return this.restartPod({
                                cluster,
                                pod,
                            })
                        }
                        case "remove": {
                            return this.removePod({
                                cluster,
                                pod,
                            })
                        }
                        case "restart_or_remove": {
                            if (
                                pod.restartCount <
                                cluster.config.restartCountToDrop
                            ) {
                                return this.restartPod({
                                    cluster,
                                    pod,
                                })
                            }

                            return this.removePod({
                                cluster,
                                pod,
                            })
                        }
                    }
                }),
        )
    }

    async loadInitialPods() {
        const initialPods = await this.mom.connector.load(
            this.mom.state.clusters.map((a) => a.config.id),
        )

        initialPods.map(({ name, pods }) => {
            this.mom.state.clusters = this.mom.state.clusters.map((a) => {
                if (a.config.id !== name) {
                    return a
                }

                a.pods = pods

                return a
            })
        })
    }

    async addPod({ cluster }: { cluster: ClusterState }) {
        try {
            const pod = await this.mom.connector.add(cluster.config)

            console.info({
                cluster: cluster.config.id,
                op: "add-pod",
                podId: pod.id,
            })

            pod.status = "starting"

            cluster.pods.push(pod)
        } catch (error) {
            console.warn({
                cluster: cluster.config.id,
                op: "add-pod",
                error,
            })
        }
    }

    async removePod({ cluster, pod }: { cluster: ClusterState; pod: Pod }) {
        try {
            await this.mom.connector.remove(pod)

            cluster.pods = cluster.pods.filter((a) => a.id !== pod.id)

            console.info({
                cluster: cluster.config.id,
                op: "remove-pod",
                podId: pod.id,
            })
        } catch (error) {
            console.warn({
                cluster: cluster.config.id,
                op: "remove-pod",
                error,
            })
        }
    }

    async restartPod({ cluster, pod }: { cluster: ClusterState; pod: Pod }) {
        try {
            await this.mom.connector.restart(pod)

            pod.restartCount++
            pod.healthyCheckCount = 0
            pod.unhealthyCheckCount = 0
            pod.status = "restarting"

            console.info({
                cluster: cluster.config.id,
                op: "restart-pod",
                podId: pod.id,
            })
        } catch (error) {
            console.warn({
                cluster: cluster.config.id,
                op: "restart-pod",
                error,
            })
        }
    }
}

class Cluster {
    static status(cluster: ClusterState) {
        if (Cluster.healthyCount(cluster) >= cluster.config.targetPodCount) {
            return "healthy"
        }

        if (Cluster.okCount(cluster) >= cluster.config.targetPodCount) {
            return "ok"
        }

        return "unhealthy"
    }

    static healthyCount(cluster: ClusterState) {
        return cluster.pods.filter((a) => a.status === "healthy").length
    }

    static okCount(cluster: ClusterState) {
        return cluster.pods.filter(
            (a) =>
                a.status === "healthy" ||
                a.status === "grey" ||
                a.status === "restarting" ||
                a.status === "starting",
        ).length
    }
}
