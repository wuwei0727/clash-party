import BasePage from '@renderer/components/base/base-page'
import LogItem from '@renderer/components/logs/log-item'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Divider, Input, Select, SelectItem } from '@heroui/react'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'
import { IoLocationSharp, IoPauseCircle, IoPlayCircle } from 'react-icons/io5'
import { CgTrash } from 'react-icons/cg'
import { useTranslation } from 'react-i18next'
import { includesIgnoreCase } from '@renderer/utils/includes'

const LOGS_FILTER_KEY = 'logs-filter'
const MAX_CACHED_LOGS = 500
const LOG_RENDER_INTERVAL_MS = 100
const LOGS_LEVEL_KEY = 'logs-level'

const LOG_LEVELS: { key: LogLevel | 'all'; label: string }[] = [
  { key: 'all', label: 'ALL' },
  { key: 'info', label: 'INFO' },
  { key: 'warning', label: 'WARNING' },
  { key: 'error', label: 'ERROR' },
  { key: 'debug', label: 'DEBUG' }
]

const cachedLogs: {
  log: IMihomoLogInfo[]
  trigger: ((i: IMihomoLogInfo[]) => void) | null
  paused: boolean
  clean: () => void
} = {
  log: [],
  trigger: null,
  paused: false,
  clean(): void {
    this.log = []
    if (this.trigger !== null) {
      this.trigger(this.log)
    }
  }
}

const onLog = (_e: unknown, ...args: unknown[]): void => {
const onLog = (_e: unknown, ...args: unknown[]): void => {
  if (cachedLogs.paused) return
  const log = args[0] as IMihomoLogInfo
  log.time = new Date().toLocaleString()
  cachedLogs.log.push(log)
  if (cachedLogs.log.length > MAX_CACHED_LOGS) {
    cachedLogs.log.splice(0, cachedLogs.log.length - MAX_CACHED_LOGS)
  }
  cachedLogs.trigger?.(cachedLogs.log)
}

// Keep streaming while this page is hidden so returning users can see intervening logs.
// The session cache is bounded by MAX_CACHED_LOGS, so stopping on unmount hurts UX
// without providing meaningful memory savings.
window.electron.ipcRenderer.on('mihomoLogs', onLog)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.electron.ipcRenderer.removeListener('mihomoLogs', onLog)
  })
}

const Logs: React.FC = () => {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<IMihomoLogInfo[]>(cachedLogs.log)
  const [filter, setFilter] = useState(() => {
    return localStorage.getItem(LOGS_FILTER_KEY) || ''
  })
  const [logLevel, setLogLevel] = useState<LogLevel | 'all'>(() => {
    return (localStorage.getItem(LOGS_LEVEL_KEY) as LogLevel | 'all') || 'all'
  })
  const [paused, setPaused] = useState(false)
  const [trace, setTrace] = useState(true)

  const virtuosoRef = useRef<VirtuosoHandle>(null)

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      const matchLevel = logLevel === 'all' || log.type === logLevel
      const matchFilter =
        filter === '' ||
        includesIgnoreCase(log.payload, filter) ||
        includesIgnoreCase(log.type, filter)
      return matchLevel && matchFilter
    })
  }, [logs, filter, logLevel])

  useEffect(() => {
    localStorage.setItem(LOGS_FILTER_KEY, filter)
  }, [filter])

  useEffect(() => {
    localStorage.setItem(LOGS_LEVEL_KEY, logLevel)
  }, [logLevel])

  useEffect(() => {
    cachedLogs.paused = paused
  }, [paused])

  useEffect(() => {
    const old = cachedLogs.trigger
    let renderTimer: ReturnType<typeof setTimeout> | null = null

    cachedLogs.trigger = (): void => {
      if (renderTimer !== null) return
      renderTimer = setTimeout(() => {
        renderTimer = null
        setLogs([...cachedLogs.log])
      }, LOG_RENDER_INTERVAL_MS)
    }

    return (): void => {
      cachedLogs.trigger = old
      if (renderTimer !== null) {
        clearTimeout(renderTimer)
      }
    }
  }, [])

  return (
    <BasePage title={t('logs.title')}>
      <div className="sticky top-0 z-40">
        <div className="w-full flex p-2 gap-2">
          <Input
            size="sm"
            value={filter}
            placeholder={t('logs.filter')}
            isClearable
            onValueChange={setFilter}
            className="flex-1"
          />
          <Select
            size="sm"
            className="w-32"
            selectedKeys={[logLevel]}
            aria-label={t('logs.level')}
            onSelectionChange={(keys) => {
              const selected = Array.from(keys)[0] as LogLevel | 'all'
              if (selected) setLogLevel(selected)
            }}
          >
            {LOG_LEVELS.map((level) => (
              <SelectItem key={level.key}>{level.label}</SelectItem>
            ))}
          </Select>
          <Button
            size="sm"
            isIconOnly
            color={paused ? 'warning' : 'default'}
            variant={paused ? 'solid' : 'bordered'}
            title={t('logs.pause')}
            onPress={() => {
              setPaused((prev) => !prev)
            }}
          >
            {paused ? <IoPlayCircle className="text-lg" /> : <IoPauseCircle className="text-lg" />}
          </Button>
          <Button
            size="sm"
            isIconOnly
            color={trace ? 'primary' : 'default'}
            variant={trace ? 'solid' : 'bordered'}
            title={t('logs.autoScroll')}
            onPress={() => {
              setTrace((prev) => !prev)
            }}
          >
            <IoLocationSharp className="text-lg" />
          </Button>
          <Button
            size="sm"
            isIconOnly
            title={t('logs.clear')}
            variant="light"
            color="danger"
            onPress={() => {
              cachedLogs.clean()
            }}
          >
            <CgTrash className="text-lg" />
          </Button>
        </div>
        <Divider />
      </div>
      <div className="h-[calc(100vh-100px)] mt-px">
        <Virtuoso
          ref={virtuosoRef}
          data={filteredLogs}
          initialTopMostItemIndex={filteredLogs.length - 1}
          followOutput={trace}
          itemContent={(i, log) => (
            <LogItem index={i} time={log.time} type={log.type} payload={log.payload} />
          )}
        />
      </div>
    </BasePage>
  )
}

export default Logs
