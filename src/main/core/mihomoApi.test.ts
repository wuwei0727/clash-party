import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const axiosInstance = {
    get: vi.fn(),
    put: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    interceptors: {
      response: {
        use: vi.fn()
      }
    }
  }

  return {
    axiosInstance,
    axiosCreate: vi.fn(() => axiosInstance),
    generateProfile: vi.fn(async () => 'profile-a'),
    send: vi.fn(),
    scheduleRuntimeConfigUpload: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    }
  }
})

vi.mock('axios', () => ({
  default: {
    create: mocks.axiosCreate
  }
}))

vi.mock('../config', () => ({
  getAppConfig: vi.fn(async () => ({ diffWorkDir: false })),
  getControledMihomoConfig: vi.fn(async () => ({}))
}))

vi.mock('../window', () => ({
  mainWindow: {
    webContents: {
      send: mocks.send
    }
  }
}))

vi.mock('../resolve/tray', () => ({ tray: null }))
vi.mock('../resolve/floatingWindow', () => ({ floatingWindow: null }))
vi.mock('../utils/calc', () => ({ calcTraffic: vi.fn() }))
vi.mock('../utils/logger', () => ({ createLogger: vi.fn(() => mocks.logger) }))
vi.mock('../utils/dirs', () => ({
  mihomoWorkConfigPath: vi.fn(() => 'C:\\work\\config.yaml')
}))
vi.mock('./factory', () => ({
  generateProfile: mocks.generateProfile,
  getRuntimeConfig: vi.fn(async () => ({}))
}))
vi.mock('./manager', () => ({
  getMihomoIpcPath: vi.fn(() => '\\\\.\\pipe\\mihomo-test')
}))
vi.mock('../resolve/gistApi', () => ({
  scheduleRuntimeConfigUpload: mocks.scheduleRuntimeConfigUpload
}))

describe('mihomoHotReloadConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.axiosInstance.put.mockResolvedValue(undefined)
  })

  it('notifies proxy groups and rules after the new config is applied', async () => {
    const { mihomoHotReloadConfig } = await import('./mihomoApi')

    await mihomoHotReloadConfig()

    expect(mocks.axiosInstance.put).toHaveBeenCalledWith('/configs?force=true', {
      path: 'C:\\work\\config.yaml'
    })
    expect(mocks.send).toHaveBeenCalledWith('groupsUpdated')
    expect(mocks.send).toHaveBeenCalledWith('rulesUpdated')
    expect(mocks.scheduleRuntimeConfigUpload).toHaveBeenCalledTimes(1)
  })

  it('does not publish refresh events when the config reload fails', async () => {
    const { mihomoHotReloadConfig } = await import('./mihomoApi')
    mocks.axiosInstance.put.mockRejectedValueOnce(new Error('reload failed'))

    await expect(mihomoHotReloadConfig()).rejects.toThrow('reload failed')

    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.scheduleRuntimeConfigUpload).not.toHaveBeenCalled()
  })
})
