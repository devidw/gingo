import type { IConnector } from "../../i-connector.js"
import { Pod, type ClusterConfig, type PodStatus } from "../../types.js"
import {
    uniqueNamesGenerator,
    adjectives,
    animals,
} from "unique-names-generator"

function genName() {
    return uniqueNamesGenerator({ dictionaries: [adjectives, animals] })
}

let PODS: {
    id: string
    name: string
}[] = [
    {
        id: genName(),
        name: "gingo-chat",
    },
]

export class DummyConnector implements IConnector {
    async getStatus(pod: Pod): Promise<PodStatus> {
        return "healthy"
    }

    async load(names: string[]) {
        return names.map((name) => {
            return {
                name,
                pods: PODS.filter((a) => a.name === `gingo-${name}`).map(
                    (a) => {
                        return new Pod(a.id)
                    },
                ),
            }
        })
    }

    async add(clusterConfig: ClusterConfig) {
        const newOne = new Pod(genName())
        newOne.status = "starting"
        PODS.push({
            id: newOne.id,
            name: "gingo-" + clusterConfig.id,
        })
        return newOne
    }

    async remove(pod: Pod) {
        PODS = PODS.filter((a) => a.id !== pod.id)
    }

    async restart(pod: Pod) {
        //
    }
}
