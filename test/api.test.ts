import { deepCopy } from 'deep-copy-ts'
import httpStatus from 'http-status-codes'
import fetch from 'node-fetch'
import sleep from 'sleep-promise'
import supertest from 'supertest'
import config from '../config'
import App from '../src/app'
import { TGetResponse, TGroup } from '../src/endpoints/groups'
import { TInstance } from '../src/endpoints/instances'

let request: supertest.SuperTest<supertest.Test>
let app: App
let res: supertest.Response

describe('CRUD', () => {
  beforeEach(async () => {
    const testConfig = deepCopy(config)
    testConfig.emptyDB = true
    app = new App(testConfig)
    await new Promise(resolve => {
      app.on('ready', resolve)
    })
    request = supertest(app.httpServer)
  })

  afterEach(async () => {
    await app.close()
  })

  it('create an instance', async () => {
    const now = Date.now()
    const meta = { foo: 'bar' }
    let res: supertest.Response

    // add an instance
    await request
      .post('/foo1/bar1')
      .send(meta)
      .expect('Content-Type', /json/)
      .expect(meta)
      .expect(httpStatus.OK)

    // check the instance
    res = await request
      .get(`/foo1`)
      .expect('Content-Type', /json/)
      .expect(httpStatus.OK)
    const instance = res.body[0] as TInstance
    expect(instance.createdAt).toBeGreaterThanOrEqual(now)
    expect(instance.updatedAt).toBeGreaterThanOrEqual(now)
    expect(instance.createdAt).toEqual(instance.createdAt)
    expect(instance).toMatchObject({
      id: 'bar1',
      group: 'foo1',
      meta
    })

    // check the group
    res = await request
      .get(`/`)
      .expect('Content-Type', /json/)
      .expect(httpStatus.OK)
    const group = res.body[0] as TGroup
    expect(group.createdAt).toBeGreaterThanOrEqual(now)
    expect(group.lastUpdatedAt).toBeGreaterThanOrEqual(now)
    expect(group).toMatchObject({
      group: 'foo1',
      instances: '1'
    })
  })

  it('delete an instance', async () => {
    let res: supertest.Response

    // add an instance
    await request.post('/foo1/bar1').send()

    // remove the instance
    await request.delete(`/foo1/bar1`).expect(httpStatus.NO_CONTENT)

    // check the instance
    await request.get(`/foo1`).expect(httpStatus.NOT_FOUND)
  })
})

describe('scenarios', () => {
  beforeEach(async () => {
    const testConfig = deepCopy(config)
    testConfig.emptyDB = true
    app = new App(testConfig)
    await new Promise(resolve => {
      app.on('ready', resolve)
    })
    request = supertest(app.httpServer)
  })

  afterEach(async () => {
    await app.close()
  })

  it('empty list on start', async () => {
    await request
      .get(`/`)
      .expect('Content-Type', /json/)
      .expect([])
      .expect(httpStatus.OK)
  })

  it('second instance updates the group (timer, counter)', async () => {
    // instance bar1
    await request.post('/foo1/bar1').send()
    await sleep(10)
    // instance bar2
    await request.post('/foo1/bar2').send()

    // assert times differ
    res = await request.get(`/foo1`)
    const instances = res.body as TInstance[]
    expect(instances[0].createdAt != instances[1].createdAt).toBeTruthy()
    const latest = Math.max(instances[0].createdAt, instances[1].createdAt)

    // check the group's time
    res = await request.get(`/`)
    const group = res.body[0] as TGetResponse[0]
    expect(group.lastUpdatedAt).toBeGreaterThanOrEqual(latest)
    expect(group.instances).toEqual('2')
  })

  it("heartbeat bumps the instances's timer", async () => {
    let instance: TInstance

    // add an instance
    await request.post('/foo1/bar1').send()
    instance = await getInstanceByID('foo1', 'bar1')
    const { createdAt } = instance
    await sleep(10)
    // heartbeat
    await request.post('/foo1/bar1').send()

    instance = await getInstanceByID('foo1', 'bar1')
    expect(instance.updatedAt).toBeGreaterThan(instance.createdAt)
    // createdAt shouldnt change
    expect(instance.createdAt).toEqual(createdAt)
  })
})

describe('GC', () => {
  beforeEach(async () => {
    const testConfig = deepCopy(config)
    testConfig.emptyDB = true
    // quick timeouts
    testConfig.instanceTimeout = 100
    // GC on every group request
    testConfig.gcInterval = 1
    app = new App(testConfig)
    await new Promise(resolve => {
      app.on('ready', resolve)
    })
    request = supertest(app.httpServer)
  })

  afterEach(async () => {
    await app.close()
  })

  // check if the instances from before `sleep` will be disposed
  it('remove expired instances and groups', async () => {
    await request.post('/foo1/bar1-1').send()
    await request.post('/foo1/bar1-2').send()
    await request.post('/foo2/bar2-1').send()
    await sleep(100)
    await request.post('/foo1/bar1-3').send()
    await request.post('/foo3/bar3-1').send()
    // GC kicks in here
    const instances1 = await getGroupInstances('foo1')
    const instances3 = await getGroupInstances('foo3')

    await request.get(`/foo2`).expect(httpStatus.NOT_FOUND)
    expect(instances1).toHaveLength(1)
    expect(instances3).toHaveLength(1)
  })
})

describe('Concurrency', () => {
  beforeEach(async () => {
    const testConfig = deepCopy(config)
    testConfig.emptyDB = true
    testConfig.httpPort = 3030
    app = new App(testConfig)
    await new Promise(resolve => {
      app.on('ready', resolve)
    })
    request = supertest(app.httpServer)
  })

  afterEach(async () => {
    await app.close()
  })

  // similar to the GC test, but with concurrent requests
  it('simultaneous writes', async () => {
    // TODO small gaps are needed bc theres no sync (event-loop level) locks
    // `supertest` cant be used, as its bulks all the requests at the same time
    let tasks: Promise<any>[] = []
    const host = 'http://localhost:3030'
    const sleepTime = 5

    tasks.push(fetch(`${host}/foo1/bar1-1`, { method: 'post' }))
    await sleep(sleepTime)
    tasks.push(fetch(`${host}/foo1/bar1-2`, { method: 'post' }))
    await sleep(sleepTime)
    tasks.push(fetch(`${host}/foo1/bar1-3`, { method: 'post' }))
    await sleep(sleepTime)
    tasks.push(fetch(`${host}/foo2/bar2-1`, { method: 'post' }))
    await sleep(sleepTime)
    tasks.push(fetch(`${host}/foo3/bar3-1`, { method: 'post' }))

    // has to be separated coz theres no read locks
    await Promise.all(tasks)

    tasks = []

    tasks.push(fetch(`${host}/foo1`).then(res => res.json()))
    await sleep(sleepTime)
    tasks.push(fetch(`${host}/foo2`).then(res => res.json()))
    await sleep(sleepTime)
    tasks.push(fetch(`${host}/foo3`).then(res => res.json()))
    await sleep(sleepTime)

    const [instances1, instances2, instances3] = await Promise.all(tasks)

    expect(instances1).toHaveLength(3)
    expect(instances2).toHaveLength(1)
    expect(instances3).toHaveLength(1)
    expect(app.gcCounter).toEqual(1)
  })
})

async function getGroupInstances (gid: string): Promise<TInstance[]> {
  const res = await request.get(`/${gid}`)
  return res.body as TInstance[]
}

async function getInstanceByID (gid: string, id: string): Promise<TInstance> {
  for (const item of await getGroupInstances(gid)) {
    if (item.id === id) {
      return item
    }
  }
  throw new Error('Not found')
}
