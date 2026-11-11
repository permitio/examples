import { Alert } from '@chakra-ui/react';

interface ErrorAlertProps {
  message: string;
  title?: string;
}

/** Shows why a request failed; for a deny, the message is the API route's explanation. */
export function ErrorAlert({ message, title = 'Not allowed' }: ErrorAlertProps) {
  return (
    <Alert.Root status="error" borderRadius="md">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{title}</Alert.Title>
        <Alert.Description>{message}</Alert.Description>
      </Alert.Content>
    </Alert.Root>
  );
}
