test_runpod:
    node --loader=ts-node/esm --inspect=0.0.0.0:1234 ./src/connectors/runpod/runpod.test.ts

test_runpod_brk:
    node --loader=ts-node/esm --inspect-brk=0.0.0.0:1234 ./src/connectors/runpod/runpod.test.ts