import React, { createContext, useContext, ReactNode } from 'react'
import useSWR, { KeyedMutator } from 'swr'
import { mihomoGroups } from '@renderer/utils/ipc'

interface GroupsContextType {
  groups: IMihomoMixedGroup[] | undefined
  mutate: KeyedMutator<IMihomoMixedGroup[]>
  showHidden: boolean
  setShowHidden: React.Dispatch<React.SetStateAction<boolean>>
}

const GroupsContext = createContext<GroupsContextType | undefined>(undefined)

export const GroupsProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [showHidden, setShowHidden] = React.useState(false)
  const { data: groups, mutate } = useSWR<IMihomoMixedGroup[]>(
    ['mihomoGroups', showHidden],
    () => mihomoGroups(showHidden),
    {
      errorRetryInterval: 200,
      errorRetryCount: 10,
      refreshInterval: 30000,
      // 订阅切换事件必须立即读取新内核状态，不能复用切换前 5 秒内的请求
      dedupingInterval: 0,
      keepPreviousData: true,
      revalidateOnFocus: false
    }
  )

  React.useEffect(() => {
    const handler = (): void => {
      mutate()
    }
    window.electron.ipcRenderer.on('groupsUpdated', handler)
    return (): void => {
      window.electron.ipcRenderer.removeListener('groupsUpdated', handler)
    }
  }, [mutate])

  return (
    <GroupsContext.Provider value={{ groups, mutate, showHidden, setShowHidden }}>
      {children}
    </GroupsContext.Provider>
  )
}

export const useGroups = (): GroupsContextType => {
  const context = useContext(GroupsContext)
  if (context === undefined) {
    throw new Error('useGroups must be used within an GroupsProvider')
  }
  return context
}
