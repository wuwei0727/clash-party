import { Button, Card, CardBody, CardFooter, Tooltip } from '@heroui/react'
import { toast } from '@renderer/components/base/toast'
import BorderSwitch from '@renderer/components/base/border-switch'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { setSysProxyEnabled, updateTrayIcon, updateTrayIconImmediate } from '@renderer/utils/ipc'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import { AiOutlineGlobal } from 'react-icons/ai'
import React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useTranslation } from 'react-i18next'

interface Props {
  iconOnly?: boolean
}

const SysproxySwitcher: React.FC<Props> = (props) => {
  const { t } = useTranslation()
  const { iconOnly } = props
  const location = useLocation()
  const navigate = useNavigate()
  const match = location.pathname.includes('/sysproxy')
  const { appConfig, mutateAppConfig } = useAppConfig()
  const { controledMihomoConfig } = useControledMihomoConfig()
  const { sysProxy, sysproxyCardStatus = 'col-span-1', disableAnimations = false } = appConfig || {}
  const { tun } = controledMihomoConfig || {}
  const { enable } = sysProxy || {}
  const [pendingEnable, setPendingEnable] = React.useState<boolean | null>(null)
  const pendingEnableRef = React.useRef<boolean | null>(null)
  const selected = pendingEnable ?? enable ?? false

  const {
    attributes,
    listeners,
    setNodeRef,
    transform: tf,
    transition,
    isDragging
  } = useSortable({
    id: 'sysproxy'
  })
  const transform = tf ? { x: tf.x, y: tf.y, scaleX: 1, scaleY: 1 } : null

  const refreshAuthoritativeUi = async (): Promise<void> => {
    try {
      await mutateAppConfig()
    } catch {
      // The tray refresh below still reads the canonical main-process state.
    }
    window.electron.ipcRenderer.send('updateFloatingWindow')
    try {
      await updateTrayIcon()
    } catch {
      // Keep menu refresh and pending-state cleanup independent from icon errors.
    }
    window.electron.ipcRenderer.send('updateTrayMenu')
  }

  const onChange = async (nextEnable: boolean): Promise<void> => {
    if (pendingEnableRef.current !== null) return

    const tunEnabled = tun?.enable ?? false
    pendingEnableRef.current = nextEnable
    setPendingEnable(nextEnable)
    updateTrayIconImmediate(nextEnable, tunEnabled)

    try {
      const applied = await setSysProxyEnabled(nextEnable)
      await refreshAuthoritativeUi()
      if (!applied) return
    } catch (error) {
      await refreshAuthoritativeUi()
      toast.error(String(error))
    } finally {
      pendingEnableRef.current = null
      setPendingEnable(null)
    }
  }

  if (iconOnly) {
    return (
      <div className={`${sysproxyCardStatus} flex justify-center`}>
        <Tooltip content={t('sider.cards.systemProxy')} placement="right">
          <Button
            size="sm"
            isIconOnly
            color={match ? 'primary' : 'default'}
            variant={match ? 'solid' : 'light'}
            onPress={() => {
              navigate('/sysproxy')
            }}
          >
            <AiOutlineGlobal className="text-[20px]" />
          </Button>
        </Tooltip>
      </div>
    )
  }

  return (
    <div
      style={{
        position: 'relative',
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 'calc(infinity)' : undefined
      }}
      className={`${sysproxyCardStatus} sysproxy-card`}
    >
      <Card
        fullWidth
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        className={`${match ? 'bg-primary' : 'hover:bg-primary/30'} ${disableAnimations ? '' : `motion-reduce:transition-transform-background ${isDragging ? 'scale-[0.95] tap-highlight-transparent' : ''}`}`}
      >
        <CardBody className="pb-1 pt-0 px-0">
          <div className="flex justify-between">
            <Button
              isIconOnly
              className="bg-transparent pointer-events-none"
              variant="flat"
              color="default"
            >
              <AiOutlineGlobal
                className={`${match ? 'text-primary-foreground' : 'text-foreground'} text-[24px] font-bold`}
              />
            </Button>
            <BorderSwitch
              isShowBorder={match && selected}
              isSelected={selected}
              isDisabled={pendingEnable !== null}
              onValueChange={onChange}
            />
          </div>
        </CardBody>
        <CardFooter className="pt-1">
          <h3
            className={`text-md font-bold sider-card-title ${match ? 'text-primary-foreground' : 'text-foreground'}`}
          >
            {t('sider.cards.systemProxy')}
          </h3>
        </CardFooter>
      </Card>
    </div>
  )
}

export default SysproxySwitcher
