import type { IConnector } from "./i-connector.js"
import {
    type ClusterState,
    type CallbacksConfig,
    type Pod,
    type PodStatus,
    type State,
    clusterconfigSchema,
} from "./types.js"
import { z } from "zod"

class OurTimeoutError extends Error {}

export class Gingo {
    callbacks: CallbacksConfig
    state: State = { clusters: [] }

    protected ops: Ops
    connector: IConnector

    jobs: Promise<void>[] = []

    constructor({
        callbacks,
        connector,
    }: {
        callbacks: CallbacksConfig
        connector: IConnector
    }) {
        this.callbacks = callbacks

        this.connector = connector

        this.ops = new Ops(this)
    }

    async setClusterConfigs(rawClusterConfigs: unknown) {
        const parsed = z.array(clusterconfigSchema).parse(rawClusterConfigs)

        // make sure we don't add any more jobs before we mutate our state
        this.clearIntervals()

        // make sure all pending jobs are finished before we start mutating, so
        // we don't mess things up
        await Promise.allSettled(this.jobs)

        // make absolutely sure we are idle
        for (const cluster of this.state.clusters) {
            if (cluster.checkStatus === "busy") {
                throw new Error(
                    "can not update config on non-idle state, this is an application issue, since the config updater should make sure we are idle before we update the cluster state with fresh config",
                )
            }
        }

        const newIds = parsed.map((a) => a.id)

        // drop old ones
        this.state.clusters = this.state.clusters.filter((a) =>
            newIds.includes(a.config.id),
        )

        for (const clusterConfig of parsed) {
            const clusterState = this.state.clusters.find(
                (a) => a.config.id === clusterConfig.id,
            )

            if (clusterState) {
                // update
                clusterState.config = clusterConfig
            } else {
                // create
                this.state.clusters.push({
                    checkStatus: "idle",
                    config: clusterConfig,
                    pods: [],
                    interval: null,
                })
            }
        }

        await this.ops.loadInitialPods()

        // instant check
        await Promise.allSettled(
            this.state.clusters.map((a) => this.maybeCheckCluster(a)),
        )

        this.setupIntervals()
    }

    stop() {
        this.clearIntervals()
    }

    setupIntervals() {
        for (const cluster of this.state.clusters) {
            cluster.interval = setInterval(
                () => {
                    this.jobs.push(this.maybeCheckCluster(cluster))
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

    async maybeCheckCluster(cluster: ClusterState) {
        if (!cluster.config.enabled) return

        if (cluster.checkStatus === "busy") return

        cluster.checkStatus = "busy"

        await Promise.allSettled(
            cluster.pods.map(async (pod) => {
                await this.checkClusterPod(cluster, pod)
                console.info(pod)
            }),
        )

        await this.maybePerfomClusterOps(cluster)

        cluster.checkStatus = "idle"
    }

    async checkClusterPod(cluster: ClusterState, pod: Pod) {
        const currentStatus = await this.connector.getStatus(pod)

        if (currentStatus === "unhealthy") {
            pod.status = "unhealthy"
            return
        }

        let pass = false

        try {
            pass = (await Promise.race([
                this.callbacks.checkPodHealth({
                    clusterConfig: cluster.config,
                    podId: pod.id,
                }),
                new Promise((resolve, reject) =>
                    setTimeout(() => {
                        reject(new OurTimeoutError())
                    }, cluster.config.checkTimeoutS * 1000),
                ),
            ])) as boolean

            if (!pass) {
                throw new Error("unhealthy check")
            }

            pod.unhealthyCheckCount = 0
            pod.healthyCheckCount++
            pod.lastHealthy = new Date().toISOString()
        } catch (e) {
            pass = false
            pod.healthyCheckCount = 0
            pod.unhealthyCheckCount++
        }

        pod.lastCheck = new Date().toISOString()

        if (!pass) {
            if (pod.isStarting) {
                if (
                    Date.now() - new Date(pod.lastStart!).getTime() <
                    cluster.config.startTimeoutMin * 60 * 1000
                ) {
                    pod.status = "starting"
                    return
                }
            }

            if (pod.isRestarting) {
                if (
                    Date.now() - new Date(pod.lastRestart!).getTime() <
                    cluster.config.restartTimeoutMin * 60 * 1000
                ) {
                    pod.status = "restarting"
                    return
                }
            }
        }

        if (pod.healthyCheckCount >= cluster.config.healthyCheckCount) {
            pod.status = "healthy"
            pod.restartCount = 0
            return
        }

        if (pod.unhealthyCheckCount >= cluster.config.unhealthyCheckCount) {
            pod.status = "unhealthy"
            return
        }

        pod.status = "grey"
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

        if (this.callbacks.onPodListUpdate) {
            this.callbacks.onPodListUpdate({
                clusterConfig: cluster.config,
                podIds,
            })
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
                if (a.config.id !== name || a.pods.length > 0) {
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

            if (this.mom.callbacks.afterPodStart) {
                this.mom.callbacks.afterPodStart({
                    clusterConfig: cluster.config,
                    podId: pod.id,
                })
            }

            pod.start()

            cluster.pods.push(pod)

            console.info({
                cluster: cluster.config.id,
                op: "add-pod",
                podId: pod.id,
            })
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

            pod.restart()

            if (this.mom.callbacks.afterPodRestart) {
                this.mom.callbacks.afterPodRestart({
                    clusterConfig: cluster.config,
                    podId: pod.id,
                })
            }

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
