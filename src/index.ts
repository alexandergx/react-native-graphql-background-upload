import { ApolloLink, FetchResult, Observable, } from '@apollo/client/core'
import { selectHttpOptionsAndBody, fallbackHttpConfig, } from '@apollo/client/link/http'
import { print, } from 'graphql/language/printer'
import Upload, { MultipartUploadOptions, } from 'react-native-background-upload'
import { extractFiles, isExtractableFile, } from 'extract-files'

export interface UploadLinkOptions {
  uri: string,
  isExtractableFile?: (file: any) => boolean,
  includeExtensions?: boolean,
  headers?: Record<string, string>,
}

export interface UploadCallbacks {
  onError?: (e: any) => void,
  onCancelled?: (e: any) => void,
  onProgress?: (e: any) => void,
  onCompleted?: (e: any) => void,
}

export interface ExtendedContext {
  headers: { 'access-token': string | null | undefined, }
  callbacks?: UploadCallbacks,
}

const createUploadPromise = async (options: MultipartUploadOptions, callbacks?: UploadCallbacks) => {
  const uploadId = await Upload.startUpload(options)
  return new Promise((resolve, reject) => {
    const errorHandler = (data: any) => {
      console.log('[UPLOAD LINK ERROR]', data)
      Upload.cancelUpload(uploadId) // TODO - handle retries, edgecases?
      reject(data.error)
      callbacks?.onError?.(data.error)
    }
    Upload.addListener('error', uploadId, errorHandler)
    Upload.addListener('cancelled', uploadId, errorHandler)
    Upload.addListener('progress', uploadId, (progress) => {
      callbacks?.onProgress?.(progress)
    })
    Upload.addListener('completed', uploadId, (data) => {
      resolve(JSON.parse(data.responseBody))
      callbacks?.onCompleted?.(data)
    })
  })
}

export const createUploadLink: (options: UploadLinkOptions) => ApolloLink = ({
  uri,
  isExtractableFile: customIsExtractableFile = isExtractableFile,
  includeExtensions = false,
}) => {
  try {
    return new ApolloLink((operation) => {
      const { headers } = operation.getContext()
      const context = operation.getContext()
      const {
        clientAwareness: { name = null, version = null, } = {},
        headers: contextHeaders,
        callbacks,
      } = context
      const contextConfig = {
        http: context.http,
        options: context.fetchOptions,
        credentials: context.credentials,
        headers: {
          ...context.headers,
          ...(name && { 'apollographql-client-name': name }),
          ...(version && { 'apollographql-client-version': version }),
          ...contextHeaders,
        },
      }
      const { body } = selectHttpOptionsAndBody(
        operation,
        fallbackHttpConfig,
        { http: { includeExtensions }, options: { uri }, },
        contextConfig
      )
      const { files } = extractFiles(body, '', (file: any): file is any => {
        return customIsExtractableFile(file)
      })
      const operations = {
        query: print(operation.query),
        variables: operation.variables,
        operationName: operation.operationName,
      }
      const map: Record<string, any[]> = {}
      const parts: Array<{ name: string, filename: string, data: any, }> = []
      let i = 0
      files.forEach((paths, file) => {
        const key = `${i}`
        map[key] = paths
        parts.push({ name: `${i}`, filename: `file`, data: file, })
        i++
      })
      const combinedHeaders = { ...headers, ...contextConfig.headers, }
      if (parts.length === 0) {
        return new Observable<FetchResult>((observer) => {
          fetch(uri, {
            method: 'POST',
            headers: { ...combinedHeaders, 'Content-Type': 'application/json', },
            body: JSON.stringify(body),
          })
            .then((response: any) => {
              if (!response.ok) return response.text().then((e: any) => { throw new Error(e) })
              return response.json()
            })
            .then(data => {
              observer.next(data)
              observer.complete()
            })
            .catch(observer.error.bind(observer))
        })
      } else {
        return new Observable<FetchResult>((observer) => {
          const promises = parts.map((part) => {
            const specificMap = { [part.name]: map[part.name] }
            const options: MultipartUploadOptions = {
              headers: { ...combinedHeaders },
              parameters: { operations: JSON.stringify(operations), map: JSON.stringify(specificMap), },
              url: uri,
              type: 'multipart',
              method: 'POST',
              field: part.name,
              path: part.data.uri,
            }
            return createUploadPromise(options, callbacks)
          })
          Promise.all(promises)
            .then((results) => {
              results.forEach((result) => {
                observer.next(result as FetchResult)
              })
              observer.complete()
              Upload.canSuspendIfBackground()
            })
            .catch(observer.error.bind(observer))
        })
      }
    })
  } catch(e: any) {
    console.log('[CUSTOM LINK ERROR]')
    throw new Error(e)
  }
}
