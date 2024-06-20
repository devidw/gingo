import { Pod, type ClusterConfig, type PodStatus } from "./types.js"

export interface IConnector {
    getStatus: (pod: Pod) => Promise<PodStatus>
    load: (names: string[]) => Promise<{ name: string; pods: Pod[] }[]>
    add: (clusterConfig: ClusterConfig) => Promise<Pod>
    remove: (pod: Pod) => Promise<void>
    restart: (pod: Pod) => Promise<void>
}
