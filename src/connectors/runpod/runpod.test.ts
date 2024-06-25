import { RunPodConnector } from "./runpod.js"
import { Gingo } from "../../gingo.js"
import fs from "fs"
import type { ClusterConfig } from "../../types.js"

const connector = new RunPodConnector(process.env.RP!)

const gingo = new Gingo({
    callbacks: {
        checkPodHealth: async ({ clusterConfig, podId }) => {
            const mockOk = false
            // const mockOk = true
            // const mockOk = Math.random() > 0.5
            // const mockOk = Math.random() > 0.75
            console.info({ podId, mockOk })
            return mockOk
        },

        onPodListUpdate: async (podIds) => {
            console.info({ podIds })

            fs.writeFileSync(
                "debug.json",
                JSON.stringify(gingo.state.clusters[0].pods, null, 4),
            )
        },
        afterPodStart: async (podId) => {
            console.log(`after pod start on ${podId}`)
        },
        afterPodRestart: async (podId) => {
            console.log(`after pod restart on ${podId}`)
        },
    },
    connector: connector,
})

await gingo.setClusterConfigs([
    {
        id: "test",
        enabled: true,
        checkIntervalMin: 0.2,
        checkTimeoutS: 10,
        healthyCheckCount: 3,
        unhealthyCheckCount: 3,
        targetPodCount: 2,
        restartCountToDrop: 1,

        restartTimeoutMin: 1,
        startTimeoutMin: 1,

        connectorAdd: {
            cloudType: "SECURE",
            containerDiskInGb: 5,
            volumeInGb: 5,
            gpuCount: 1,
            gpuTypeId: "NVIDIA RTX 2000 Ada Generation",
            minMemoryInGb: 31,
            minVcpuCount: 6,
            templateId: "runpod-torch-v21",
            ports: "8888/http,22/tcp",
            startJupyter: false,
            startSsh: false,
            volumeKey: null,
            dataCenterId: null,
            networkVolumeId: null,
        },
    },
] satisfies ClusterConfig[])
