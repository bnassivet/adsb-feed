import sys
import df17_pb2

# Encoding a message
def encode_message(df, ca, icao_code, type_code, pi):
    message = df17_pb2.DF17()
    message.DF = df
    message.CA = ca
    message.ICAO_Code = icao_code
    message.Type_code = type_code
    message.PI = pi
    
    return message.SerializeToString()

# Decoding a message
def decode_message(encoded_message):
    message = df17_pb2.DF17()
    message.ParseFromString(encoded_message)
    
    return message

# Example usage
encoded_message = encode_message(17, df17_pb2.CA_0, 123456, df17_pb2.Aircraft_Identification, 123456789)
decoded_message = decode_message(encoded_message)

print("Decoded message:")
print("DF:", decoded_message.DF)
print("CA:", decoded_message.CA)
print("ICAO_Code:", decoded_message.ICAO_Code)
print("Type_code:", decoded_message.Type_code)
print("PI:", decoded_message.PI)
