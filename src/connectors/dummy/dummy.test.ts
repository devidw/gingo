import { DummyConnector } from "./dummy.js"
import { Gingo } from "../../gingo.js"
import type { ClusterConfig } from "../../types.js"

const dummyConnector = new DummyConnector()

const gingo = new Gingo({
    callbacks: {
        checkPodHealth: async ({ podId }) => {
            const mockOk = Math.random() > 0.75
            // const mockOk = false
            console.info({ podId, mockOk })
            return mockOk
        },

        onPodListUpdate: async (podIds) => {
            console.info({ podIds })
        },
    },
    connector: dummyConnector,
})

await gingo.setClusterConfigs([
    {
        id: "chat",
        enabled: true,
        checkIntervalMin: 1,
        checkTimeoutS: 10,
        healthyCheckCount: 3,
        unhealthyCheckCount: 3,
        targetPodCount: 2,
        restartCountToDrop: 1,
        connectorAdd: {},

        restartTimeoutMin: 1,
        startTimeoutMin: 1,
    },
] satisfies ClusterConfig[])
