# lets test our backend file

from backend import run_travel_agent

user_input = input("Enter travel request: ")

response = run_travel_agent(
    user_input=user_input, 
    thread_id="test_user"
)

print("\n FINAL RESPONSE:\n")
print(response["answer"])
